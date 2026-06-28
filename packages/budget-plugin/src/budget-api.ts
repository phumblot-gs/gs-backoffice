/**
 * Native Paperclip budget API client (read-only, best-effort).
 *
 * AUTH PATH (discovered for GRA-42 Step 2): a budget-plugin worker runs *inside* the
 * Paperclip server container and reaches the native budget API over loopback. It reuses
 * the exact convention the mcp-server's PaperclipClient uses:
 *   - PAPERCLIP_API_URL    — control-plane base URL (e.g. http://localhost:3100)
 *   - PAPERCLIP_API_KEY    — board API key, sent as `Authorization: Bearer …`
 *   - PAPERCLIP_COMPANY_ID — the company whose budgets we read
 * These three are provisioned into the `paperclip` container (terraform compute module,
 * mirroring how EVT_* is wired) and forwarded to the worker by the ADAPTER_ENV_PASSTHROUGH
 * patch (docker/patches/patch-paperclip-plugin-env.mjs). No secret values live in code.
 *
 * All reads are best-effort: any missing config or transport error resolves to `null`
 * so the caller (the alert-poll / snapshot jobs) never throws.
 */

// Mirrors @paperclipai/shared `BudgetOverview` (pinned 2026.609.0). Kept local so the
// plugin needs no extra dependency; the write-side contract test in apps/mcp-server
// guards the schemas that actually matter for drift.
export type BudgetStatus = 'ok' | 'warning' | 'hard_stop';
export type BudgetThresholdType = 'soft' | 'hard';
export type BudgetScopeType = 'company' | 'agent' | 'project';

export interface BudgetPolicySummary {
  policyId: string;
  scopeType: BudgetScopeType;
  scopeId: string;
  scopeName: string;
  amount: number;
  observedAmount: number;
  remainingAmount: number;
  utilizationPercent: number;
  status: BudgetStatus;
  paused: boolean;
  pauseReason: string | null;
  /** Budget window kind for this policy (e.g. `calendar_month_utc`, `lifetime`). */
  windowKind?: string;
  windowStart?: string;
  windowEnd?: string;
}

export interface BudgetIncident {
  id: string;
  scopeType: BudgetScopeType;
  scopeId: string;
  scopeName: string;
  thresholdType: BudgetThresholdType;
  amountLimit: number;
  amountObserved: number;
  status: string;
}

export interface BudgetOverview {
  companyId: string;
  policies: BudgetPolicySummary[];
  activeIncidents: BudgetIncident[];
  pausedAgentCount: number;
  pausedProjectCount: number;
  pendingApprovalCount?: number;
}

// Cost breakdowns (GRA-42 Step 3): spend for ALL agents/projects, including scopes with
// NO budget policy. Amounts are integer cents. Mirrors the costs/by-agent + costs/by-project
// responses; the snapshot builder merges these with the overview policies.
export interface AgentCost {
  agentId: string;
  agentName: string;
  spentCents: number;
}

export interface ProjectCost {
  projectId: string;
  projectName: string;
  spentCents: number;
}

export interface CostsByAgentResponse {
  agents: AgentCost[];
}

export interface CostsByProjectResponse {
  projects: ProjectCost[];
}

export interface BudgetApiConfig {
  apiUrl: string;
  apiKey?: string;
  companyId: string;
}

/** Read the budget API config from env; null if the essential pieces are absent. */
export function readBudgetApiConfig(env: NodeJS.ProcessEnv): BudgetApiConfig | null {
  const apiUrl = (env.PAPERCLIP_API_URL || '').trim().replace(/\/$/, '');
  const companyId = (env.PAPERCLIP_COMPANY_ID || '').trim();
  const apiKey = (env.PAPERCLIP_API_KEY || '').trim() || undefined;
  if (!apiUrl || !companyId) return null;
  return { apiUrl, apiKey, companyId };
}

type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export class BudgetApiClient {
  constructor(
    private readonly config: BudgetApiConfig,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
  ) {}

  /** Authenticated GET returning parsed JSON, or null on any failure (best-effort). */
  private async getJson<T>(path: string): Promise<T | null> {
    const { apiUrl, apiKey, companyId } = this.config;
    const url = `${apiUrl}/api/companies/${companyId}${path}`;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    try {
      const res = await this.fetchImpl(url, { method: 'GET', headers });
      if (!res.ok) return null;
      const text = await res.text();
      if (!text) return null;
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }

  /** GET /api/companies/:companyId/budgets/overview — typed, best-effort (null on any failure). */
  async getBudgetsOverview(): Promise<BudgetOverview | null> {
    return this.getJson<BudgetOverview>('/budgets/overview');
  }

  /**
   * GET /api/companies/:companyId/costs/by-agent — spend for EVERY agent (budgeted or not).
   * Tolerates either a bare array or a `{ agents: [...] }` envelope. Best-effort (null on failure).
   */
  async getCostsByAgent(): Promise<AgentCost[] | null> {
    const raw = await this.getJson<CostsByAgentResponse | AgentCost[]>('/costs/by-agent');
    if (!raw) return null;
    return Array.isArray(raw) ? raw : (raw.agents ?? []);
  }

  /**
   * GET /api/companies/:companyId/costs/by-project — spend for EVERY project (budgeted or not).
   * Tolerates either a bare array or a `{ projects: [...] }` envelope. Best-effort (null on failure).
   */
  async getCostsByProject(): Promise<ProjectCost[] | null> {
    const raw = await this.getJson<CostsByProjectResponse | ProjectCost[]>('/costs/by-project');
    if (!raw) return null;
    return Array.isArray(raw) ? raw : (raw.projects ?? []);
  }
}
