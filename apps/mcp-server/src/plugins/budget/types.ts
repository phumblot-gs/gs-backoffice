/**
 * Local budget types for the Henri MCP server's BudgetPlugin. Mirrors the relevant
 * fields of Paperclip's native budget API (kept local to avoid a runtime dep on
 * @paperclipai/shared — the schemas it pins are exercised by the contract tests).
 */
export type BudgetStatus = 'ok' | 'warning' | 'hard_stop';
export type BudgetThresholdType = 'soft' | 'hard';
export type BudgetScopeType = 'company' | 'agent' | 'project';

export interface BudgetPolicySummary {
  policyId?: string;
  scopeType: BudgetScopeType;
  scopeId: string;
  scopeName?: string;
  amount?: number;
  observedAmount?: number;
  remainingAmount?: number;
  utilizationPercent?: number;
  status?: BudgetStatus;
  paused?: boolean;
}

export interface BudgetIncident {
  id: string;
  scopeType: BudgetScopeType;
  scopeId: string;
  scopeName?: string;
  thresholdType: BudgetThresholdType;
  amountLimit?: number;
  amountObserved?: number;
  status?: string;
}

export interface BudgetOverview {
  companyId?: string;
  policies?: BudgetPolicySummary[];
  activeIncidents?: BudgetIncident[];
  pausedAgentCount?: number;
  pausedProjectCount?: number;
}

export type UpsertBudgetPolicyBody = {
  scopeType: BudgetScopeType;
  scopeId: string;
  amount: number;
  metric?: string;
  windowKind?: string;
  warnPercent?: number;
  hardStopEnabled?: boolean;
  notifyEnabled?: boolean;
  isActive?: boolean;
};

export type ResolveBudgetIncidentBody = {
  action: 'raise_budget_and_resume' | 'keep_paused';
  amount?: number;
  decisionNote?: string;
};
