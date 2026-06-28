import { describe, it, expect } from 'vitest';
import { buildAlertMessage, collectAlerts, diffAlerts, type BudgetAlert } from './alerts.js';
import type { BudgetOverview } from './budget-api.js';

const softAlert: BudgetAlert = {
  key: 'inc:i1:soft',
  kind: 'incident',
  scopeType: 'agent',
  scopeId: 'a1',
  scopeName: 'Henri',
  status: 'warning',
  thresholdType: 'soft',
  observed: 80000,
  limit: 100000,
};
const hardAlert: BudgetAlert = {
  ...softAlert,
  key: 'inc:i1:hard',
  status: 'hard_stop',
  thresholdType: 'hard',
  observed: 110000,
};

describe('buildAlertMessage', () => {
  it('soft alert names the scope, consumption/limit, status, and the resolve tool', () => {
    const msg = buildAlertMessage(softAlert);
    expect(msg).toContain('Henri');
    expect(msg).toContain('Agent');
    expect(msg).toContain('800.00 €');
    expect(msg).toContain('1000.00 €');
    expect(msg).toContain('warning');
    expect(msg).toContain('henri_resolve_budget');
  });

  it('hard alert shows hard-stop status and the 🚨 marker', () => {
    const msg = buildAlertMessage(hardAlert);
    expect(msg).toContain('hard_stop');
    expect(msg).toContain('🚨');
    expect(msg).toContain('1100.00 €');
  });
});

function overview(partial: Partial<BudgetOverview>): BudgetOverview {
  return {
    companyId: 'c1',
    policies: [],
    activeIncidents: [],
    pausedAgentCount: 0,
    pausedProjectCount: 0,
    ...partial,
  };
}

describe('diffAlerts dedup', () => {
  it('first occurrence notifies; repeat does not', () => {
    const current = collectAlerts(
      overview({
        activeIncidents: [
          {
            id: 'i1',
            scopeType: 'agent',
            scopeId: 'a1',
            scopeName: 'Henri',
            thresholdType: 'soft',
            amountLimit: 100000,
            amountObserved: 80000,
            status: 'open',
          },
        ],
      }),
    );
    const first = diffAlerts(current, {});
    expect(first.toNotify).toHaveLength(1);
    const second = diffAlerts(current, first.nextState);
    expect(second.toNotify).toHaveLength(0);
  });

  it('soft→hard escalation on the same incident re-notifies exactly once', () => {
    const soft = collectAlerts(
      overview({
        activeIncidents: [
          {
            id: 'i1',
            scopeType: 'agent',
            scopeId: 'a1',
            scopeName: 'Henri',
            thresholdType: 'soft',
            amountLimit: 100000,
            amountObserved: 80000,
            status: 'open',
          },
        ],
      }),
    );
    const afterSoft = diffAlerts(soft, {});
    expect(afterSoft.toNotify).toHaveLength(1);

    const hard = collectAlerts(
      overview({
        activeIncidents: [
          {
            id: 'i1',
            scopeType: 'agent',
            scopeId: 'a1',
            scopeName: 'Henri',
            thresholdType: 'hard',
            amountLimit: 100000,
            amountObserved: 110000,
            status: 'open',
          },
        ],
      }),
    );
    const afterHard = diffAlerts(hard, afterSoft.nextState);
    expect(afterHard.toNotify).toHaveLength(1);
    expect(afterHard.toNotify[0].status).toBe('hard_stop');
    const repeat = diffAlerts(hard, afterHard.nextState);
    expect(repeat.toNotify).toHaveLength(0);
  });

  it('a newly budget-paused scope notifies once and then dedups', () => {
    const paused = collectAlerts(
      overview({
        policies: [
          {
            policyId: 'p1',
            scopeType: 'project',
            scopeId: 'pr1',
            scopeName: 'Launch',
            amount: 100000,
            observedAmount: 100000,
            remainingAmount: 0,
            utilizationPercent: 100,
            status: 'hard_stop',
            paused: true,
            pauseReason: 'budget',
          },
        ],
      }),
    );
    const first = diffAlerts(paused, {});
    expect(first.toNotify).toHaveLength(1);
    expect(first.toNotify[0].kind).toBe('paused');
    expect(diffAlerts(paused, first.nextState).toNotify).toHaveLength(0);
  });
});
