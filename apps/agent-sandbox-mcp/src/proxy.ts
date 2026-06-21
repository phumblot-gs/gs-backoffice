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
  /** The issue this run is working on (PAPERCLIP_TASK_ID); default target for report_progress. */
  taskIssueId?: string;
}

export class ProxyConfigError extends Error {}

/**
 * Read the proxy config from the (inherited) Paperclip run env. The claude_local
 * adapter sets PAPERCLIP_API_URL / PAPERCLIP_API_KEY / PAPERCLIP_RUN_ID and
 * buildPaperclipEnv adds PAPERCLIP_AGENT_ID / PAPERCLIP_COMPANY_ID.
 *
 * NOTE: `projectId` is NOT required here. The executeTool route mandates a
 * `runContext.projectId`, but the claude_local adapter does not expose a project id
 * to the run's env (and `PAPERCLIP_*` keys set via adapterConfig.env do not propagate
 * to the MCP child on Local runs — verified on staging). So projectId is resolved
 * separately via `resolveProjectId` (env override → first authorized company project).
 */
export function readProxyConfig(env: NodeJS.ProcessEnv = process.env): ProxyConfig {
  const get = (k: string) => (env[k] ?? '').trim();
  const apiKey = get('PAPERCLIP_API_KEY');
  const agentId = get('PAPERCLIP_AGENT_ID');
  const runId = get('PAPERCLIP_RUN_ID');
  const companyId = get('PAPERCLIP_COMPANY_ID');
  const projectId = get('PAPERCLIP_PROJECT_ID') || undefined;

  const missing = Object.entries({
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

  // The bridge always runs ON the Paperclip container (the agent's Local env), so it
  // calls the server over LOOPBACK. Paperclip's `PAPERCLIP_API_URL` resolves to the
  // public base URL, which routes through the ALB (60s cap) and 504s long-running
  // tools like sandbox_code_task — loopback bypasses that. `PAPERCLIP_SANDBOX_API_URL`
  // is an explicit override if ever needed.
  const port = get('PORT') || get('PAPERCLIP_LISTEN_PORT') || '3100';
  const apiUrl = (get('PAPERCLIP_SANDBOX_API_URL') || `http://127.0.0.1:${port}`).replace(
    /\/+$/,
    '',
  );

  return {
    apiUrl,
    apiKey,
    runContext: { agentId, runId, companyId, projectId },
    taskIssueId: get('PAPERCLIP_TASK_ID') || undefined,
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

// Resolved once per process (the answer is stable for the run's identity).
let cachedProjectId: string | null = null;

/** Test-only: clear the resolved-project cache. */
export function __resetProjectCache(): void {
  cachedProjectId = null;
}

/**
 * Resolve the `projectId` to send in runContext. Priority:
 *   1. `PAPERCLIP_PROJECT_ID` env (explicit override, if it ever propagates).
 *   2. The first project the actor is authorized for in its company
 *      (`GET /api/companies/{companyId}/projects`). The route only checks that the
 *      project belongs to the company, and the sandbox plugin does not use projectId,
 *      so any authorized company project satisfies the gate. Cached after first call.
 */
export async function resolveProjectId(
  cfg: ProxyConfig,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<string> {
  if (cfg.runContext.projectId) return cfg.runContext.projectId;
  if (cachedProjectId) return cachedProjectId;

  const url = `${cfg.apiUrl}/api/companies/${cfg.runContext.companyId}/projects`;
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
    });
  } catch (err) {
    throw new Error(
      `agent-sandbox-mcp: failed to list projects at ${url}: ${(err as Error).message}`,
    );
  }
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(
      `agent-sandbox-mcp: cannot resolve projectId (GET projects → HTTP ${res.status}): ${raw.slice(0, 400)}`,
    );
  }
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    throw new Error(
      `agent-sandbox-mcp: cannot resolve projectId — non-JSON projects response: ${raw.slice(0, 200)}`,
    );
  }
  const arr = (
    Array.isArray(list)
      ? list
      : ((list as { projects?: unknown[]; data?: unknown[] }).projects ??
        (list as { data?: unknown[] }).data ??
        [])
  ) as Array<{ id?: string }>;
  const first = arr.find((p) => typeof p?.id === 'string')?.id;
  if (!first) {
    throw new Error(
      `agent-sandbox-mcp: cannot resolve a projectId — the run actor has no authorized projects in company ${cfg.runContext.companyId}. ` +
        `Set PAPERCLIP_PROJECT_ID or grant the agent a project.`,
    );
  }
  cachedProjectId = first;
  return first;
}

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
  const projectId = await resolveProjectId(cfg, fetchImpl);
  const url = `${cfg.apiUrl}/api/plugins/tools/execute`;
  const body = JSON.stringify({
    tool: `${SANDBOX_PLUGIN_ID}:${toolName}`,
    parameters,
    runContext: { ...cfg.runContext, projectId },
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

/** Statuses an agent may move its own issue to via report_progress. */
export const REPORT_STATUSES = [
  'in_progress',
  'in_review',
  'blocked',
  'done',
  'cancelled',
  'todo',
] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export interface ReportInput {
  /** Defaults to the run's current issue (PAPERCLIP_TASK_ID). */
  issueId?: string;
  status?: ReportStatus;
  comment?: string;
}

/**
 * Update the run's own issue (status and/or comment) via `PATCH /api/issues/:id`,
 * authenticated as the run with the `X-Paperclip-Run-Id` header — the same path the
 * built-in agent skill drives with curl, but as a native tool so the agent needs no
 * shell access. Over loopback (set in cfg.apiUrl).
 */
export async function reportProgress(
  cfg: ProxyConfig,
  input: ReportInput,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<{ status: string; identifier?: string }> {
  const issueId = (input.issueId || cfg.taskIssueId || '').trim();
  if (!issueId) {
    throw new Error(
      'agent-sandbox-mcp: report_progress needs an issueId (none provided and PAPERCLIP_TASK_ID is unset).',
    );
  }
  if (!input.status && !input.comment) {
    throw new Error(
      'agent-sandbox-mcp: report_progress requires at least one of status or comment.',
    );
  }
  const payload: Record<string, unknown> = {};
  if (input.status) payload.status = input.status;
  if (input.comment) payload.comment = input.comment;

  const url = `${cfg.apiUrl}/api/issues/${issueId}`;
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        'X-Paperclip-Run-Id': cfg.runContext.runId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    throw new Error(
      `agent-sandbox-mcp: report_progress request to ${url} failed: ${(err as Error).message}`,
    );
  }
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(
      `agent-sandbox-mcp: report_progress → HTTP ${res.status}: ${raw.slice(0, 600)}`,
    );
  }
  let parsed: { status?: string; identifier?: string } = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    /* the route returns the updated issue; a non-JSON body is non-fatal */
  }
  return { status: parsed.status ?? 'updated', identifier: parsed.identifier };
}
