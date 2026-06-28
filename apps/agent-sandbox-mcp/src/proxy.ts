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
let cachedProjectContext: ResolvedProjectContext | null = null;

/** Test-only: clear the resolved-project caches. */
export function __resetProjectCache(): void {
  cachedProjectId = null;
  cachedProjectContext = null;
}

/**
 * Read the run's own project id from its issue (`GET /api/issues/{taskIssueId}`), which
 * returns both `projectId` and a resolved `project` object. Best-effort: returns
 * undefined (never throws) so resolution can fall back to a company project.
 */
async function fetchIssueProjectId(
  cfg: ProxyConfig,
  fetchImpl: FetchLike,
): Promise<string | undefined> {
  const issueId = (cfg.taskIssueId || '').trim();
  if (!issueId) return undefined;
  try {
    const res = await fetchImpl(`${cfg.apiUrl}/api/issues/${issueId}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
    });
    if (!res.ok) return undefined;
    const j = JSON.parse(await res.text()) as {
      projectId?: string | null;
      project?: { id?: string | null } | null;
    };
    return (j.projectId || j.project?.id || undefined) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the `projectId` to send in runContext. Priority:
 *   1. `PAPERCLIP_PROJECT_ID` env (explicit override, if it ever propagates).
 *   2. The run's OWN project, read from its issue (`GET /api/issues/{taskIssueId}` →
 *      `projectId`/`project.id`). This is the correct project, so repoUrl + the engineer
 *      are resolved from it (not just any project the actor can see).
 *   3. The first project the actor is authorized for in its company
 *      (`GET /api/companies/{companyId}/projects`) — a fallback that still satisfies the
 *      executeTool gate (the route only checks the project belongs to the company).
 * Cached after the first call.
 */
export async function resolveProjectId(
  cfg: ProxyConfig,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<string> {
  if (cfg.runContext.projectId) return cfg.runContext.projectId;
  if (cachedProjectId) return cachedProjectId;

  const fromIssue = await fetchIssueProjectId(cfg, fetchImpl);
  if (fromIssue) {
    cachedProjectId = fromIssue;
    return fromIssue;
  }

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
 * What the run's project context yields for the tools: the repo bound to the project
 * and the engineer agent — so the orchestrator need not be told either. Any field may
 * be undefined if the project has no repo bound / no engineer assigned.
 */
export interface ResolvedProjectContext {
  projectId: string;
  repoUrl?: string;
  defaultRef?: string;
  engineerAgentId?: string;
}

/**
 * Resolve the run's project context once per process: the project's bound `repoUrl`
 * (from `codebase.repoUrl`, a read-only projection of the primary workspace) and the
 * company's `engineer` agent. Both are read-only GETs — they never provision a
 * workspace, so the sandbox isolation boundary is untouched. Best-effort per field:
 * a missing repo/engineer leaves that field undefined (the caller raises a precise
 * error only if the value is actually needed and was not passed explicitly).
 */
export async function resolveProjectContext(
  cfg: ProxyConfig,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<ResolvedProjectContext> {
  if (cachedProjectContext) return cachedProjectContext;
  const projectId = await resolveProjectId(cfg, fetchImpl);
  const ctx: ResolvedProjectContext = { projectId };

  // repoUrl + defaultRef from the project's codebase projection (or its primary workspace).
  try {
    const res = await fetchImpl(`${cfg.apiUrl}/api/projects/${projectId}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
    });
    if (res.ok) {
      const p = JSON.parse(await res.text()) as {
        codebase?: { repoUrl?: string | null; defaultRef?: string | null } | null;
        primaryWorkspace?: { repoUrl?: string | null; defaultRef?: string | null } | null;
      };
      ctx.repoUrl = (p.codebase?.repoUrl || p.primaryWorkspace?.repoUrl || undefined) ?? undefined;
      ctx.defaultRef =
        (p.codebase?.defaultRef || p.primaryWorkspace?.defaultRef || undefined) ?? undefined;
    }
  } catch {
    /* leave repoUrl/defaultRef unset; resolveRepoUrl errors only if actually needed */
  }

  // The engineer agent (role === "engineer") — the default assignee for engineer steps.
  try {
    const res = await fetchImpl(`${cfg.apiUrl}/api/companies/${cfg.runContext.companyId}/agents`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
    });
    if (res.ok) {
      const raw = JSON.parse(await res.text());
      const arr = (Array.isArray(raw) ? raw : (raw.agents ?? raw.data ?? [])) as Array<{
        id?: string;
        role?: string;
      }>;
      ctx.engineerAgentId = arr.find((a) => a?.role === 'engineer' && typeof a.id === 'string')?.id;
    }
  } catch {
    /* leave engineerAgentId unset */
  }

  cachedProjectContext = ctx;
  return ctx;
}

/**
 * The git URL to operate on: the explicit value if the agent passed one, else the repo
 * bound to the run's project. Throws a precise, actionable error if neither is available.
 */
export async function resolveRepoUrl(
  cfg: ProxyConfig,
  explicit?: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<string> {
  const v = (explicit || '').trim();
  if (v) return v;
  const ctx = await resolveProjectContext(cfg, fetchImpl);
  if (ctx.repoUrl) return ctx.repoUrl;
  throw new Error(
    `agent-sandbox-mcp: no repoUrl given and project ${ctx.projectId} has no repo bound. ` +
      `Set the project's primary workspace repoUrl (sourceType git_repo), or pass repoUrl explicitly.`,
  );
}

/**
 * The agent to assign an engineer step to: the explicit value if given, else the
 * company's `engineer` agent. Throws a precise error if neither is available.
 */
export async function resolveEngineerAgentId(
  cfg: ProxyConfig,
  explicit?: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<string> {
  const v = (explicit || '').trim();
  if (v) return v;
  const ctx = await resolveProjectContext(cfg, fetchImpl);
  if (ctx.engineerAgentId) return ctx.engineerAgentId;
  throw new Error(
    `agent-sandbox-mcp: no assigneeAgentId given and no agent with role "engineer" found ` +
      `in company ${cfg.runContext.companyId}. Assign an engineer agent, or pass assigneeAgentId explicitly.`,
  );
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

// ---------------------------------------------------------------------------
// GitHub PR + diff review (1b). The bridge talks to GitHub directly using the
// container's scoped tokens (read for diffs, push for PRs) — the token value never
// enters the agent's context, so the orchestrator needs no GitHub credential or shell.
// ---------------------------------------------------------------------------

const GITHUB_API = 'https://api.github.com';

/** Parse `owner/repo` from a github.com clone URL (https or ssh form). */
export function parseGitHubRepo(repoUrl: string): { owner: string; repo: string } {
  const m = repoUrl.trim().match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (!m) throw new Error(`agent-sandbox-mcp: cannot parse owner/repo from "${repoUrl}".`);
  return { owner: m[1], repo: m[2] };
}

/** The container's GitHub token for the requested access mode (read vs push). */
export function githubToken(mode: 'read' | 'push', env: NodeJS.ProcessEnv = process.env): string {
  const get = (k: string) => (env[k] ?? '').trim();
  const combined = get('SANDBOX_GITHUB_TOKEN');
  const token =
    mode === 'push'
      ? get('SANDBOX_GITHUB_PUSH_TOKEN') || combined
      : get('SANDBOX_GITHUB_READ_TOKEN') || combined;
  if (!token) {
    throw new Error(
      `agent-sandbox-mcp: no GitHub ${mode} token available (set SANDBOX_GITHUB_${mode === 'push' ? 'PUSH' : 'READ'}_TOKEN or SANDBOX_GITHUB_TOKEN).`,
    );
  }
  return token;
}

function ghHeaders(token: string, accept = 'application/vnd.github+json'): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: accept,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'gs-agent-sandbox-mcp',
  };
}

/** Open a pull request for a pushed branch. Uses the push-scoped token. */
export async function openPr(
  input: { repoUrl: string; head: string; base?: string; title: string; body?: string },
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ number: number; url: string }> {
  const { owner, repo } = parseGitHubRepo(input.repoUrl);
  const token = githubToken('push', env);
  const url = `${GITHUB_API}/repos/${owner}/${repo}/pulls`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: input.title,
      head: input.head,
      base: input.base || 'main',
      body: input.body || '',
    }),
  });
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`agent-sandbox-mcp: open_pr → HTTP ${res.status}: ${raw.slice(0, 600)}`);
  }
  const j = JSON.parse(raw) as { number?: number; html_url?: string };
  return { number: j.number ?? 0, url: j.html_url ?? '' };
}

/** Return the unified diff of base...head for review. Uses the read-scoped token. */
export async function getDiff(
  input: { repoUrl: string; base: string; head: string; maxBytes?: number },
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const { owner, repo } = parseGitHubRepo(input.repoUrl);
  const token = githubToken('read', env);
  const range = `${encodeURIComponent(input.base)}...${encodeURIComponent(input.head)}`;
  const url = `${GITHUB_API}/repos/${owner}/${repo}/compare/${range}`;
  const res = await fetchImpl(url, {
    method: 'GET',
    headers: ghHeaders(token, 'application/vnd.github.diff'),
  });
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`agent-sandbox-mcp: get_diff → HTTP ${res.status}: ${raw.slice(0, 600)}`);
  }
  const max = input.maxBytes && input.maxBytes > 0 ? input.maxBytes : 50_000;
  if (raw.length > max) {
    return `${raw.slice(0, max)}\n\n[...diff truncated at ${max} bytes; refine with a narrower base...head or review per-file...]`;
  }
  return raw || '(no changes between base and head)';
}

// ---------------------------------------------------------------------------
// Governance orchestration (Bloc 2 B3). The Methods Officer drives the engineer
// loop as a living graph of child issues. Because the orchestrator has no shell,
// creating/reading those child issues are native tools (run-authenticated via the
// X-Paperclip-Run-Id header, over loopback) — never curl.
// ---------------------------------------------------------------------------

export interface CreateChildInput {
  title: string;
  description?: string;
  /** Agent to assign the step to (e.g. the Engineer's id). */
  assigneeAgentId: string;
  /** Verifiable criteria for THIS step (≤20, each ≤500 chars). */
  acceptanceCriteria?: string[];
  /** If true, the parent (the MO's issue) stays blocked until this child is done. */
  blockParentUntilDone?: boolean;
  /** Parent issue; defaults to the run's current issue (PAPERCLIP_TASK_ID). */
  parentId?: string;
}

/**
 * Create a child issue (a step) under the run's current issue and assign it. The MO
 * uses this to decompose/iterate: spawn an Engineer step, get woken when it completes
 * (native handoff), review, then spawn the next. Run-authenticated.
 */
export async function createChildIssue(
  cfg: ProxyConfig,
  input: CreateChildInput,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<{ id: string; identifier?: string; status?: string }> {
  const parentId = (input.parentId || cfg.taskIssueId || '').trim();
  if (!parentId) {
    throw new Error(
      'agent-sandbox-mcp: create_child_issue needs a parentId (none provided and PAPERCLIP_TASK_ID is unset).',
    );
  }
  if (!input.assigneeAgentId?.trim()) {
    throw new Error('agent-sandbox-mcp: create_child_issue requires assigneeAgentId.');
  }
  const payload: Record<string, unknown> = {
    title: input.title,
    description: input.description ?? '',
    parentId,
    assigneeAgentId: input.assigneeAgentId,
    blockParentUntilDone: input.blockParentUntilDone ?? true,
  };
  if (input.acceptanceCriteria && input.acceptanceCriteria.length > 0) {
    payload.acceptanceCriteria = input.acceptanceCriteria;
  }
  const url = `${cfg.apiUrl}/api/companies/${cfg.runContext.companyId}/issues`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      'X-Paperclip-Run-Id': cfg.runContext.runId,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(
      `agent-sandbox-mcp: create_child_issue → HTTP ${res.status}: ${raw.slice(0, 600)}`,
    );
  }
  const j = JSON.parse(raw) as { id?: string; identifier?: string; status?: string };
  if (!j.id) throw new Error(`agent-sandbox-mcp: create_child_issue → no issue id in response.`);
  return { id: j.id, identifier: j.identifier, status: j.status };
}

export interface IssueView {
  id: string;
  identifier?: string;
  title?: string;
  status?: string;
  assigneeAgentId?: string | null;
  /** Most recent comments (the agent's reports), newest last, bodies truncated. */
  comments: Array<{ body: string }>;
}

/**
 * Read a child issue's current state + its latest report comments, so the MO can
 * review the Engineer's result for a step. Read-only.
 */
export async function getIssue(
  cfg: ProxyConfig,
  issueId: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<IssueView> {
  const id = issueId.trim();
  if (!id) throw new Error('agent-sandbox-mcp: get_issue requires an issueId.');
  const headers = { Authorization: `Bearer ${cfg.apiKey}` };

  const ires = await fetchImpl(`${cfg.apiUrl}/api/issues/${id}`, { method: 'GET', headers });
  const iraw = await ires.text();
  if (!ires.ok) {
    throw new Error(`agent-sandbox-mcp: get_issue → HTTP ${ires.status}: ${iraw.slice(0, 400)}`);
  }
  const issue = JSON.parse(iraw) as {
    id: string;
    identifier?: string;
    title?: string;
    status?: string;
    assigneeAgentId?: string | null;
  };

  let comments: Array<{ body: string }> = [];
  try {
    const cres = await fetchImpl(`${cfg.apiUrl}/api/issues/${id}/comments`, {
      method: 'GET',
      headers,
    });
    if (cres.ok) {
      const carr = JSON.parse(await cres.text());
      const list = Array.isArray(carr) ? carr : (carr.comments ?? carr.data ?? []);
      comments = (list as Array<{ body?: string; message?: string; content?: string }>)
        .slice(-5)
        .map((c) => ({ body: String(c.body ?? c.message ?? c.content ?? '').slice(0, 4000) }));
    }
  } catch {
    /* comments are best-effort */
  }

  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    status: issue.status,
    assigneeAgentId: issue.assigneeAgentId ?? null,
    comments,
  };
}
