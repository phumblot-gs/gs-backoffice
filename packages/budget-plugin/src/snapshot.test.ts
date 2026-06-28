import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildSnapshotPayload } from './snapshot.js';
import type { BudgetOverview } from './budget-api.js';

// Capture EvtClient.publish so we can assert the job emits exactly ONE aggregated event.
const { publish } = vi.hoisted(() => ({ publish: vi.fn() }));
vi.mock('@gs-backoffice/evt-client', () => ({
  EvtClient: vi.fn(() => ({ publish })),
}));
// Import after the mock so emitBudgetSnapshot binds the mocked EvtClient.
import { emitBudgetSnapshot } from './snapshot-emit.js';

const reportDate = '2026-06-28';
const window = { windowStart: '2026-06-01T00:00:00.000Z', windowEnd: '2026-07-01T00:00:00.000Z' };

const overview: BudgetOverview = {
  companyId: 'co1',
  pausedAgentCount: 0,
  pausedProjectCount: 0,
  activeIncidents: [],
  policies: [
    {
      policyId: 'pol-co',
      scopeType: 'company',
      scopeId: 'co1',
      scopeName: 'Acme',
      amount: 1_000_000,
      observedAmount: 250_000,
      remainingAmount: 750_000,
      utilizationPercent: 25,
      status: 'ok',
      paused: false,
      pauseReason: null,
      windowKind: 'calendar_month_utc',
      windowStart: window.windowStart,
      windowEnd: window.windowEnd,
    },
    {
      policyId: 'pol-a1',
      scopeType: 'agent',
      scopeId: 'a1',
      scopeName: 'Henri',
      amount: 100_000,
      observedAmount: 80_000,
      remainingAmount: 20_000,
      utilizationPercent: 79.6, // fractional → must round to an int (80)
      status: 'warning',
      paused: true,
      pauseReason: 'budget',
      windowKind: 'calendar_month_utc',
    },
    {
      policyId: 'pol-p1',
      scopeType: 'project',
      scopeId: 'p1',
      scopeName: 'Alpha',
      amount: 50_000,
      observedAmount: 10_000,
      remainingAmount: 40_000,
      utilizationPercent: 20,
      status: 'ok',
      paused: false,
      pauseReason: null,
      windowKind: 'calendar_quarter_utc',
    },
  ],
};

const costsByAgent = [
  { agentId: 'a1', agentName: 'Henri', spentCents: 80_000 }, // budgeted
  { agentId: 'a2', agentName: 'Bob', spentCents: 5_000 }, // NO policy
];
const costsByProject = [
  { projectId: 'p1', projectName: 'Alpha', spentCents: 10_000 }, // budgeted
  { projectId: 'p2', projectName: 'Beta', spentCents: 3_000 }, // NO policy
];

const build = () =>
  buildSnapshotPayload({ overview, costsByAgent, costsByProject, reportDate, window });

describe('buildSnapshotPayload', () => {
  it('(1) an agent WITH a budget policy gets real limit/util/status/paused', () => {
    const agent = build().agents.find((a) => a.agentId === 'a1')!;
    expect(agent).toMatchObject({
      agentName: 'Henri',
      spentCents: 80_000,
      limitCents: 100_000,
      remainingCents: 20_000,
      utilizationPercent: 80, // 79.6 rounded
      status: 'warning',
      paused: true,
    });
  });

  it('(2) an agent present ONLY in costs (no policy) gets nulls, ok, not paused', () => {
    const agent = build().agents.find((a) => a.agentId === 'a2')!;
    expect(agent).toEqual({
      agentId: 'a2',
      agentName: 'Bob',
      spentCents: 5_000,
      limitCents: null,
      remainingCents: null,
      utilizationPercent: null,
      status: 'ok',
      paused: false,
    });
  });

  it('(3) projects: budgeted vs un-budgeted incl. windowKind', () => {
    const { projects } = build();
    const p1 = projects.find((p) => p.projectId === 'p1')!;
    const p2 = projects.find((p) => p.projectId === 'p2')!;
    expect(p1).toMatchObject({
      windowKind: 'calendar_quarter_utc',
      limitCents: 50_000,
      remainingCents: 40_000,
      utilizationPercent: 20,
      status: 'ok',
      spentCents: 10_000,
    });
    expect(p2).toEqual({
      projectId: 'p2',
      projectName: 'Beta',
      windowKind: 'lifetime', // no policy → default
      spentCents: 3_000,
      limitCents: null,
      remainingCents: null,
      utilizationPercent: null,
      status: 'ok',
      paused: false,
    });
  });

  it('(4) company block + envelope are correct', () => {
    const payload = build();
    expect(payload.company).toEqual({
      limitCents: 1_000_000,
      spentCents: 250_000,
      remainingCents: 750_000,
      utilizationPercent: 25,
      status: 'ok',
      paused: false,
    });
    expect(payload.reportDate).toBe(reportDate);
    expect(payload.windowKind).toBe('calendar_month_utc');
    expect(payload.currency).toBe('USD');
    expect(payload.windowStart).toBe(window.windowStart);
    expect(payload.windowEnd).toBe(window.windowEnd);
  });

  it('(4b) coverage: every agent and every project from the costs lists appears', () => {
    const payload = build();
    expect(payload.agents.map((a) => a.agentId).sort()).toEqual(['a1', 'a2']);
    expect(payload.projects.map((p) => p.projectId).sort()).toEqual(['p1', 'p2']);
  });

  it('(5a) all amounts are integers', () => {
    const payload = build();
    const ints: Array<number | null> = [
      payload.company.limitCents,
      payload.company.spentCents,
      payload.company.remainingCents,
      payload.company.utilizationPercent,
      ...payload.agents.flatMap((a) => [
        a.spentCents,
        a.limitCents,
        a.remainingCents,
        a.utilizationPercent,
      ]),
      ...payload.projects.flatMap((p) => [
        p.spentCents,
        p.limitCents,
        p.remainingCents,
        p.utilizationPercent,
      ]),
    ];
    for (const v of ints) if (v !== null) expect(Number.isInteger(v)).toBe(true);
  });

  it('falls back to aggregated agent spend when there is no company policy', () => {
    const noCompany: BudgetOverview = {
      ...overview,
      policies: overview.policies.filter((p) => p.scopeType !== 'company'),
    };
    const payload = buildSnapshotPayload({
      overview: noCompany,
      costsByAgent,
      costsByProject,
      reportDate,
      window,
    });
    expect(payload.company).toEqual({
      limitCents: null,
      spentCents: 85_000, // 80_000 + 5_000
      remainingCents: null,
      utilizationPercent: null,
      status: 'ok',
      paused: false,
    });
  });
});

describe('emitBudgetSnapshot', () => {
  beforeEach(() => {
    publish.mockReset();
    publish.mockResolvedValue(undefined);
  });

  it('(5b) the job emits exactly ONE backoffice.budget.snapshot event', async () => {
    const payload = build();
    const env = { EVT_API_URL: 'http://evt', EVT_API_KEY: 'k', EVT_ACCOUNT_ID: 'acct' };
    const ok = await emitBudgetSnapshot(payload, env as unknown as NodeJS.ProcessEnv);
    expect(ok).toBe(true);
    expect(publish).toHaveBeenCalledTimes(1);
    const event = publish.mock.calls[0][0] as {
      eventType: string;
      scope: { resourceType: string; resourceId: string };
      payload: unknown;
    };
    expect(event.eventType).toBe('backoffice.budget.snapshot');
    expect(event.scope.resourceType).toBe('budget_snapshot');
    expect(event.scope.resourceId).toBe(reportDate);
    expect(event.payload).toEqual(payload);
  });

  it('is best-effort: no EVT config → no publish, returns false', async () => {
    const ok = await emitBudgetSnapshot(build(), {} as NodeJS.ProcessEnv);
    expect(ok).toBe(false);
    expect(publish).not.toHaveBeenCalled();
  });
});
