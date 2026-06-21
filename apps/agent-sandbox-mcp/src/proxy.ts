/**
 * Proxy core for the agent-facing sandbox MCP server.
 *
 * Paperclip 2026.609.0 does NOT expose plugin tools to a `claude_local` agent's
 * own LLM session (executeTool is only reachable via the host-side HTTP route).
 * This MCP server bridges that gap: it is launched by the agent's `claude` process
 * (via `adapterConfig.extraArgs: ["--mcp-config", …]`), inherits the run-context env
 * the adapter injects, and proxies each tool call to the DEPLOYED sandbox plugin's
 * `POST /api/plugins/tools/execute`. That keeps a single validated code path (the
 * plugin owns the Fly Sprites transport, the 15-min RPC patch, the secret gate, and
 * the idle-reaper state) and means this server never handles raw Sprite/GitHub
 * tokens — it authenticates with the run's own scoped `PAPERCLIP_API_KEY`.
 *
 * See docs/architecture/methods-officer-self-evolution.md (§10) and
 * docs/architecture/sandbox-code-tool.md.
 */

/** The deployed sandbox plugin whose tools we proxy to. */
export const SANDBOX_PLUGIN_ID = 'gs-backoffice.fly-sprites-sandbox-provider';

/** The sandbox tools this MCP server re-exposes to the agent. */
export const SANDBOX_TOOL_NAMES = ['sandbox_run', 'sandbox_code_task', 'sandbox_release'] as const;
export type SandboxToolName = (typeof SANDBOX_TOOL_NAMES)[number];

export interface RunContext {
  agentId: string;
  runId: string;
  companyId: string;
  /** Not provided by buildPaperclipEnv; forwarded when PAPERCLIP_PROJECT_ID is set. */
  projectId?: string;
}

export interface ProxyConfig {
  apiUrl: string;
  apiKey: string;
  runContext: RunContext;
}

export class ProxyConfigError extends Error {}

/**
 * Read the proxy config from the (inherited) Paperclip run env. The claude_local
 * adapter sets PAPERCLIP_API_URL / PAPERCLIP_API_KEY / PAPERCLIP_RUN_ID and
 * buildPaperclipEnv adds PAPERCLIP_AGENT_ID / PAPERCLIP_COMPANY_ID.
 */
export function readProxyConfig(env: NodeJS.ProcessEnv = process.env): ProxyConfig {
  const get = (k: string) => (env[k] ?? '').trim();
  const apiUrl = get('PAPERCLIP_API_URL');
  const apiKey = get('PAPERCLIP_API_KEY');
  const agentId = get('PAPERCLIP_AGENT_ID');
  const runId = get('PAPERCLIP_RUN_ID');
  const companyId = get('PAPERCLIP_COMPANY_ID');
  const projectId = get('PAPERCLIP_PROJECT_ID') || undefined;

  const missing = Object.entries({
    PAPERCLIP_API_URL: apiUrl,
    PAPERCLIP_API_KEY: apiKey,
    PAPERCLIP_AGENT_ID: agentId,
    PAPERCLIP_RUN_ID: runId,
    PAPERCLIP_COMPANY_ID: companyId,
  })
    .filter(([, v]) => !v)
    .map(([k]) => k);

  if (missing.length > 0) {
    throw new ProxyConfigError(
      `agent-sandbox-mcp: missing required env from the agent run context: ${missing.join(', ')}. ` +
        `This server must be launched by a Paperclip claude_local run (it inherits PAPERCLIP_* env).`,
    );
  }

  return {
    apiUrl: apiUrl.replace(/\/+$/, ''),
    apiKey,
    runContext: { agentId, runId, companyId, projectId },
  };
}

export interface ProxyResult {
  /** Human-readable summary line from the plugin tool. */
  content: string;
  /** Structured result payload (branch, sha, exitCode, stdout, …). */
  data: unknown;
}

type FetchLike = (
  url: string,
  init: RequestInit,
) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}>;

/**
 * Proxy one tool call to the deployed plugin's executeTool route.
 * Throws on transport / HTTP / tool errors with a readable message.
 */
export async function executeSandboxTool(
  cfg: ProxyConfig,
  toolName: SandboxToolName,
  parameters: Record<string, unknown>,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<ProxyResult> {
  const url = `${cfg.apiUrl}/api/plugins/tools/execute`;
  const body = JSON.stringify({
    tool: `${SANDBOX_PLUGIN_ID}:${toolName}`,
    parameters,
    runContext: cfg.runContext,
  });

  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
      body,
    });
  } catch (err) {
    throw new Error(`agent-sandbox-mcp: request to ${url} failed: ${(err as Error).message}`);
  }

  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`agent-sandbox-mcp: ${toolName} → HTTP ${res.status}: ${raw.slice(0, 800)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`agent-sandbox-mcp: ${toolName} → non-JSON response: ${raw.slice(0, 400)}`);
  }

  const result = (parsed as { result?: { content?: unknown; data?: unknown; error?: unknown } })
    .result;
  if (result?.error) {
    throw new Error(`agent-sandbox-mcp: ${toolName} tool error: ${JSON.stringify(result.error)}`);
  }

  return {
    content: typeof result?.content === 'string' ? result.content : `${toolName} completed.`,
    data: result?.data ?? null,
  };
}
