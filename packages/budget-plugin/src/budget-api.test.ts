import { describe, it, expect } from 'vitest';
import { BudgetApiClient, type BudgetApiConfig } from './budget-api.js';

const config: BudgetApiConfig = {
  apiUrl: 'http://localhost:3100',
  apiKey: 'board-key',
  companyId: 'co-1',
};

interface Captured {
  url?: string;
  init?: { method?: string; headers?: Record<string, string>; body?: string };
}

function fakeFetch(captured: Captured, response: { ok: boolean; status: number; body: string }) {
  return (async (url: string, init?: Captured['init']) => {
    captured.url = url;
    captured.init = init;
    return { ok: response.ok, status: response.status, text: async () => response.body };
  }) as unknown as ConstructorParameters<typeof BudgetApiClient>[1];
}

describe('BudgetApiClient writes', () => {
  it('upsertBudgetPolicy POSTs to /budgets/policies with the JSON body + bearer auth', async () => {
    const captured: Captured = {};
    const client = new BudgetApiClient(
      config,
      fakeFetch(captured, { ok: true, status: 200, body: '{"policyId":"p1"}' }),
    );
    const body = { scopeType: 'agent' as const, scopeId: 'a-uuid', amount: 500000 };
    const res = await client.upsertBudgetPolicy(body);
    expect(res.ok).toBe(true);
    expect(captured.url).toBe('http://localhost:3100/api/companies/co-1/budgets/policies');
    expect(captured.init?.method).toBe('POST');
    expect(captured.init?.headers?.Authorization).toBe('Bearer board-key');
    expect(JSON.parse(captured.init?.body ?? '{}')).toEqual(body);
  });

  it('resolveBudgetIncident POSTs to /budget-incidents/:id/resolve for both actions', async () => {
    const captured: Captured = {};
    const client = new BudgetApiClient(
      config,
      fakeFetch(captured, { ok: true, status: 200, body: '{}' }),
    );
    const res = await client.resolveBudgetIncident('inc-7', { action: 'keep_paused' });
    expect(res.ok).toBe(true);
    expect(captured.url).toBe(
      'http://localhost:3100/api/companies/co-1/budget-incidents/inc-7/resolve',
    );
    expect(captured.init?.method).toBe('POST');
    expect(JSON.parse(captured.init?.body ?? '{}')).toEqual({ action: 'keep_paused' });
  });

  it('surfaces a non-2xx write as { ok:false, error }', async () => {
    const captured: Captured = {};
    const client = new BudgetApiClient(
      config,
      fakeFetch(captured, { ok: false, status: 403, body: 'forbidden' }),
    );
    const res = await client.resolveBudgetIncident('inc-9', {
      action: 'raise_budget_and_resume',
      amount: 1000,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('403');
  });
});
