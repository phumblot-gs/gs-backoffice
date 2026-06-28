/**
 * Pure daily-snapshot payload builder (no network) — GRA-42 Step 3, deliverable 1b.
 *
 * Merges three best-effort sources into the EXACT `backoffice.budget.snapshot` spec payload:
 *   - `overview`       — budget policies (limit/util/status/paused) per scope, when one exists
 *   - `costsByAgent`   — spend for EVERY agent, budgeted or not
 *   - `costsByProject` — spend for EVERY project, budgeted or not
 *
 * COVERAGE RULE: we iterate the full costs lists so every agent and every project appears.
 * A scope WITH a matching policy gets real limit/remaining/util/status/paused; a scope with
 * NO policy gets limit/remaining/util = null, status "ok", paused false. All amounts are
 * integer cents. `currency` is the literal "USD" (per spec). The job passes `reportDate`
 * and `window` in so this stays a pure, unit-testable function.
 */
import type { AgentCost, BudgetOverview, BudgetPolicySummary, BudgetStatus, ProjectCost } from './budget-api.js';

export interface SnapshotWindow {
  windowStart: string | null;
  windowEnd: string | null;
}

export interface CompanySnapshot {
  limitCents: number | null;
  spentCents: number;
  remainingCents: number | null;
  utilizationPercent: number | null;
  status: BudgetStatus;
  paused: boolean;
}

export interface AgentSnapshot {
  agentId: string;
  agentName: string;
  spentCents: number;
  limitCents: number | null;
  remainingCents: number | null;
  utilizationPercent: number | null;
  status: BudgetStatus;
  paused: boolean;
}

export interface ProjectSnapshot {
  projectId: string;
  projectName: string;
  windowKind: string;
  spentCents: number;
  limitCents: number | null;
  remainingCents: number | null;
  utilizationPercent: number | null;
  status: BudgetStatus;
  paused: boolean;
}

export interface SnapshotPayload {
  reportDate: string;
  windowKind: 'calendar_month_utc';
  windowStart: string | null;
  windowEnd: string | null;
  currency: 'USD';
  company: CompanySnapshot;
  agents: AgentSnapshot[];
  projects: ProjectSnapshot[];
}

export interface BuildSnapshotInput {
  overview: BudgetOverview;
  costsByAgent: AgentCost[] | null;
  costsByProject: ProjectCost[] | null;
  reportDate: string;
  window: SnapshotWindow;
}

const toInt = (n: number): number => Math.round(n);

/** Policy-derived budget fields, all integer cents (util rounded to an int). */
function policyFields(p: BudgetPolicySummary): {
  limitCents: number;
  remainingCents: number;
  utilizationPercent: number;
  status: BudgetStatus;
  paused: boolean;
} {
  return {
    limitCents: toInt(p.amount),
    remainingCents: toInt(p.remainingAmount),
    utilizationPercent: toInt(p.utilizationPercent),
    status: p.status,
    paused: p.paused,
  };
}

/** The "no budget policy" fields applied to scopes present only in the costs lists. */
const NO_POLICY = {
  limitCents: null,
  remainingCents: null,
  utilizationPercent: null,
  status: 'ok' as BudgetStatus,
  paused: false,
} as const;

function indexPolicies(
  policies: BudgetPolicySummary[],
  scopeType: BudgetPolicySummary['scopeType'],
): Map<string, BudgetPolicySummary> {
  const map = new Map<string, BudgetPolicySummary>();
  for (const p of policies) if (p.scopeType === scopeType) map.set(p.scopeId, p);
  return map;
}

export function buildSnapshotPayload({
  overview,
  costsByAgent,
  costsByProject,
  reportDate,
  window,
}: BuildSnapshotInput): SnapshotPayload {
  const policies = overview.policies ?? [];
  const agentCosts = costsByAgent ?? [];
  const projectCosts = costsByProject ?? [];

  // Company block: use the company-scope policy if present, else aggregate agent spend.
  const companyPolicy = policies.find((p) => p.scopeType === 'company');
  const company: CompanySnapshot = companyPolicy
    ? { spentCents: toInt(companyPolicy.observedAmount), ...policyFields(companyPolicy) }
    : {
        spentCents: agentCosts.reduce((sum, c) => sum + toInt(c.spentCents), 0),
        ...NO_POLICY,
      };

  const agentPolicies = indexPolicies(policies, 'agent');
  const agents: AgentSnapshot[] = agentCosts.map((c) => {
    const policy = agentPolicies.get(c.agentId);
    return {
      agentId: c.agentId,
      agentName: c.agentName,
      spentCents: toInt(c.spentCents),
      ...(policy ? policyFields(policy) : NO_POLICY),
    };
  });

  const projectPolicies = indexPolicies(policies, 'project');
  const projects: ProjectSnapshot[] = projectCosts.map((c) => {
    const policy = projectPolicies.get(c.projectId);
    return {
      projectId: c.projectId,
      projectName: c.projectName,
      // Per-project window kind comes from the project's policy; lifetime when un-budgeted.
      windowKind: policy?.windowKind ?? 'lifetime',
      spentCents: toInt(c.spentCents),
      ...(policy ? policyFields(policy) : NO_POLICY),
    };
  });

  return {
    reportDate,
    windowKind: 'calendar_month_utc',
    windowStart: window.windowStart,
    windowEnd: window.windowEnd,
    currency: 'USD',
    company,
    agents,
    projects,
  };
}
