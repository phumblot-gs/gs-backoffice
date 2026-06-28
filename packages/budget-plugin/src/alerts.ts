/**
 * Pure budget-alert logic (no network) — collected, deduped, and rendered so it unit-tests
 * without a server. The alert-poll job (plugin.ts) wires these to the API client + EvtClient.
 */
import type {
  BudgetIncident,
  BudgetOverview,
  BudgetPolicySummary,
  BudgetStatus,
  BudgetThresholdType,
} from './budget-api.js';

export type AlertKind = 'incident' | 'paused';

export interface BudgetAlert {
  /** Stable dedup key. Includes a status marker so a soft→hard escalation re-notifies once. */
  key: string;
  kind: AlertKind;
  scopeType: string;
  scopeId: string;
  scopeName: string;
  status: BudgetStatus;
  thresholdType?: BudgetThresholdType;
  observed: number;
  limit: number;
}

/** Notified-state map persisted in plugin.state: dedup key → true. */
export type NotifiedState = Record<string, true>;

const severityFromThreshold = (t: BudgetThresholdType): BudgetStatus =>
  t === 'hard' ? 'hard_stop' : 'warning';

export function incidentAlertKey(inc: Pick<BudgetIncident, 'id' | 'thresholdType'>): string {
  return `inc:${inc.id}:${inc.thresholdType}`;
}

export function pausedAlertKey(p: Pick<BudgetPolicySummary, 'policyId'>): string {
  return `pause:${p.policyId}`;
}

/** Build the alert list for an overview: every active incident + every budget-paused scope. */
export function collectAlerts(overview: BudgetOverview): BudgetAlert[] {
  const alerts: BudgetAlert[] = [];
  for (const inc of overview.activeIncidents ?? []) {
    alerts.push({
      key: incidentAlertKey(inc),
      kind: 'incident',
      scopeType: inc.scopeType,
      scopeId: inc.scopeId,
      scopeName: inc.scopeName,
      status: severityFromThreshold(inc.thresholdType),
      thresholdType: inc.thresholdType,
      observed: inc.amountObserved,
      limit: inc.amountLimit,
    });
  }
  for (const p of overview.policies ?? []) {
    if (p.paused && p.pauseReason === 'budget') {
      alerts.push({
        key: pausedAlertKey(p),
        kind: 'paused',
        scopeType: p.scopeType,
        scopeId: p.scopeId,
        scopeName: p.scopeName,
        status: p.status,
        observed: p.observedAmount,
        limit: p.amount,
      });
    }
  }
  return alerts;
}

export interface DedupResult {
  toNotify: BudgetAlert[];
  nextState: NotifiedState;
}

/**
 * Dedup against prior notified state. Returns the alerts to send now and the next state to
 * persist. Keys no longer present are dropped from state (so a resolved-then-reopened
 * incident re-notifies), and a new status marker (soft→hard) is treated as a fresh alert.
 */
export function diffAlerts(current: BudgetAlert[], prior: NotifiedState): DedupResult {
  const nextState: NotifiedState = {};
  const toNotify: BudgetAlert[] = [];
  for (const alert of current) {
    nextState[alert.key] = true;
    if (!prior[alert.key]) toNotify.push(alert);
  }
  return { toNotify, nextState };
}

/** Format billed cents as a plain monetary amount (deterministic; locale-free). */
export function formatAmount(cents: number): string {
  return `${(cents / 100).toFixed(2)} €`;
}

const KIND_LABEL: Record<string, string> = {
  company: 'Société',
  agent: 'Agent',
  project: 'Projet',
};

const STATUS_EMOJI: Record<BudgetStatus, string> = {
  ok: '✅',
  warning: '🟠',
  hard_stop: '🚨',
};

/**
 * Render the Google Chat alert text for one budget alert. Includes the scope (type + name),
 * consumption vs limit, the status, and a reminder to use `henri_resolve_budget`.
 */
export function buildAlertMessage(alert: BudgetAlert): string {
  const emoji = STATUS_EMOJI[alert.status] ?? '⚠️';
  const scopeLabel = KIND_LABEL[alert.scopeType] ?? alert.scopeType;
  const util = alert.limit > 0 ? Math.round((alert.observed / alert.limit) * 100) : 0;
  const header =
    alert.kind === 'paused'
      ? `${emoji} Budget — ${scopeLabel} « ${alert.scopeName} » en pause (budget)`
      : `${emoji} Budget ${alert.status === 'hard_stop' ? 'hard-stop' : "seuil d'alerte"} — ${scopeLabel} « ${alert.scopeName} »`;
  return [
    header,
    `Consommation : ${formatAmount(alert.observed)} / ${formatAmount(alert.limit)} (${util} %)`,
    `Statut : ${alert.status}.`,
    '→ Utilisez `henri_resolve_budget` pour arbitrer (maintenir la pause, ou relever le budget et reprendre).',
  ].join('\n');
}
