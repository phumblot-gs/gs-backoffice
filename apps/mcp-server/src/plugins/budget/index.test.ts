import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { EvtClient } from '@gs-backoffice/evt-client';
import { upsertBudgetPolicySchema, resolveBudgetIncidentSchema } from '@paperclipai/shared';
import { PluginManager } from '../manager.js';
import type { ToolContext, PluginInitConfig } from '../types.js';
import { BudgetPlugin, buildUpsertBody, buildResolveBody, type BudgetClient } from './index.js';

const logger = pino({ level: 'silent' });

const OVERVIEW = {
  companyId: 'co-1',
  policies: [
    {
      policyId: 'p1',
      scopeType: 'agent',
      scopeId: 'a1',
      scopeName: 'Henri',
      amount: 500000,
      observedAmount: 412000,
      remainingAmount: 88000,
      utilizationPercent: 82.4,
      status: 'warning',
      paused: false,
    },
  ],
  activeIncidents: [
    {
      id: 'inc-7',
      scopeType: 'agent',
      scopeId: 'a1',
      scopeName: 'Henri',
      thresholdType: 'soft',
      amountLimit: 400000,
      amountObserved: 412000,
      status: 'open',
    },
  ],
  pausedAgentCount: 1,
  pausedProjectCount: 0,
};

class FakeClient implements BudgetClient {
  upsertCalls: Array<{ companyId: string; body: Record<string, unknown> }> = [];
  resolveCalls: Array<{ companyId: string; incidentId: string; body: Record<string, unknown> }> =
    [];
  async getBudgetsOverview(): Promise<Record<string, unknown>> {
    return OVERVIEW as unknown as Record<string, unknown>;
  }
  async upsertBudgetPolicy(
    companyId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    this.upsertCalls.push({ companyId, body });
    return { policyId: 'p1' };
  }
  async resolveBudgetIncident(
    companyId: string,
    incidentId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    this.resolveCalls.push({ companyId, incidentId, body });
    return { id: incidentId };
  }
}

const leadership: ToolContext = {
  userId: 'u1',
  userEmail: 'boss@grand-shooting.com',
  groups: ['Comex'],
  permissions: ['paperclip.read', 'paperclip.budget'],
  scopes: { paperclip: ['*'] },
  workflows: [],
  agents: [],
};

function initConfig(): PluginInitConfig {
  return { credentials: { PAPERCLIP_COMPANY_ID: 'co-1' }, evtClient: null, logger };
}

describe('BudgetPlugin body construction (contract)', () => {
  it('henri_adjust_budget builds an upsertBudgetPolicySchema-valid body', () => {
    const body = buildUpsertBody({
      scopeType: 'agent',
      scopeId: '33333333-3333-4333-8333-333333333333',
      amount: 500000,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: true,
    });
    expect(() => upsertBudgetPolicySchema.parse(body)).not.toThrow();
  });
  it('henri_resolve_budget builds resolveBudgetIncidentSchema-valid bodies for both actions', () => {
    expect(() =>
      resolveBudgetIncidentSchema.parse(
        buildResolveBody({
          incidentId: 'i',
          action: 'raise_budget_and_resume',
          amount: 750000,
          decisionNote: 'ok',
        }),
      ),
    ).not.toThrow();
    expect(() =>
      resolveBudgetIncidentSchema.parse(
        buildResolveBody({ incidentId: 'i', action: 'keep_paused' }),
      ),
    ).not.toThrow();
  });
});

describe('BudgetPlugin RBAC (leadership only)', () => {
  it('exposes the budget tools only to a paperclip.budget holder', async () => {
    const mgr = new PluginManager({ evtClient: null, environment: 'test', evtAccountId: '' });
    await mgr.register(new BudgetPlugin(new FakeClient()), initConfig());
    const names = (perms: string[]) => mgr.getAuthorizedTools(perms).map((t) => t.name);
    expect(names(['paperclip.budget'])).toEqual(
      expect.arrayContaining([
        'henri_budget_status',
        'henri_adjust_budget',
        'henri_resolve_budget',
      ]),
    );
    const denied = names(['paperclip.read', 'paperclip.create_ticket']);
    expect(denied).not.toContain('henri_budget_status');
    expect(denied).not.toContain('henri_adjust_budget');
    expect(denied).not.toContain('henri_resolve_budget');
    expect(names(['*'])).toEqual(expect.arrayContaining(['henri_adjust_budget']));
  });
});

describe('BudgetPlugin tool behaviour', () => {
  it('henri_adjust_budget calls upsertBudgetPolicy with a schema-valid body', async () => {
    const fake = new FakeClient();
    const plugin = new BudgetPlugin(fake);
    await plugin.initialize(initConfig());
    const adjust = plugin.getTools().find((t) => t.name === 'henri_adjust_budget')!;
    const res = await adjust.execute(
      {
        scopeType: 'agent',
        scopeId: '33333333-3333-4333-8333-333333333333',
        amount: 500000,
        warnPercent: 80,
        hardStopEnabled: true,
      },
      leadership,
    );
    expect(res.isError).toBeFalsy();
    expect(fake.upsertCalls).toHaveLength(1);
    expect(fake.upsertCalls[0].companyId).toBe('co-1');
    expect(() => upsertBudgetPolicySchema.parse(fake.upsertCalls[0].body)).not.toThrow();
  });

  it('henri_resolve_budget posts to the right incident for both actions', async () => {
    const fake = new FakeClient();
    const plugin = new BudgetPlugin(fake);
    await plugin.initialize(initConfig());
    const resolve = plugin.getTools().find((t) => t.name === 'henri_resolve_budget')!;
    await resolve.execute(
      {
        incidentId: 'inc-7',
        action: 'raise_budget_and_resume',
        amount: 750000,
        decisionNote: 'ok',
      },
      leadership,
    );
    await resolve.execute({ incidentId: 'inc-9', action: 'keep_paused' }, leadership);
    expect(fake.resolveCalls.map((c) => c.incidentId)).toEqual(['inc-7', 'inc-9']);
    expect(() => resolveBudgetIncidentSchema.parse(fake.resolveCalls[0].body)).not.toThrow();
    expect(fake.resolveCalls[1].body).toEqual({ action: 'keep_paused' });
  });

  it('henri_budget_status returns a readable summary', async () => {
    const plugin = new BudgetPlugin(new FakeClient());
    await plugin.initialize(initConfig());
    const status = plugin.getTools().find((t) => t.name === 'henri_budget_status')!;
    const res = await status.execute({}, leadership);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('Budget overview');
    expect(text).toContain('Henri');
    expect(text).toContain('inc-7');
  });
});

describe('BudgetPlugin audit', () => {
  it('emits exactly one backoffice.audit.tool_invoked per invocation', async () => {
    const publish = vi.fn().mockResolvedValue(undefined);
    const mgr = new PluginManager({
      evtClient: { publish } as unknown as EvtClient,
      environment: 'staging',
      evtAccountId: 'acct-1',
    });
    await mgr.register(new BudgetPlugin(new FakeClient()), initConfig());
    const handlers: Record<string, (input: unknown, extra: unknown) => Promise<unknown>> = {};
    const fakeServer = {
      tool: (
        name: string,
        _desc: string,
        _shape: unknown,
        cb: (i: unknown, e: unknown) => Promise<unknown>,
      ) => {
        handlers[name] = cb;
      },
    } as unknown as McpServer;
    mgr.registerToolsOnServer(fakeServer, leadership);
    await handlers['henri_budget_status']({}, {});
    expect(publish).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(publish.mock.calls[0][0])).toContain('backoffice.audit.tool_invoked');
  });
});
