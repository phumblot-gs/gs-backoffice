/**
 * Contract test against Paperclip's NATIVE budget API.
 *
 * Imports Paperclip's own zod validators from `@paperclipai/shared` (pinned to the
 * deployed Paperclip version) and asserts the budget request bodies the Henri budget
 * plugin will send still satisfy them. If a future Paperclip upgrade changes the budget
 * schema (renames a field, drops an action, tightens a constraint), THIS TEST FAILS at
 * build time — surfacing the broken integration before it ships. On upgrade: bump the
 * @paperclipai/shared devDep to match and re-run.
 */
import { describe, it, expect } from 'vitest';
import { upsertBudgetPolicySchema, resolveBudgetIncidentSchema } from '@paperclipai/shared';

describe('Paperclip native budget — request contract', () => {
  it('our upsert budget policy body validates against upsertBudgetPolicySchema', () => {
    const body = {
      scopeType: 'agent',
      scopeId: '33333333-3333-4333-8333-333333333333',
      amount: 500000,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: true,
    };
    expect(() => upsertBudgetPolicySchema.parse(body)).not.toThrow();
  });

  it('upsert requires only scopeType/scopeId/amount and applies defaults for the rest', () => {
    // scopeId must be a UUID (Paperclip's schema is z.string().uuid()), so the
    // company scope is keyed by the company's Paperclip UUID, not a slug.
    const parsed = upsertBudgetPolicySchema.parse({
      scopeType: 'company',
      scopeId: '44444444-4444-4444-8444-444444444444',
      amount: 1_000_000,
    });
    expect(parsed.metric).toBe('billed_cents');
    expect(typeof parsed.hardStopEnabled).toBe('boolean');
    expect(typeof parsed.isActive).toBe('boolean');
  });

  it('resolve body validates for raise_budget_and_resume (amount + decisionNote)', () => {
    expect(() =>
      resolveBudgetIncidentSchema.parse({
        action: 'raise_budget_and_resume',
        amount: 750000,
        decisionNote: 'Approved a higher cap for the launch window.',
      }),
    ).not.toThrow();
  });

  it('resolve body validates for keep_paused', () => {
    expect(() => resolveBudgetIncidentSchema.parse({ action: 'keep_paused' })).not.toThrow();
  });
});
