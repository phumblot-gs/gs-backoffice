import { describe, it, expect } from 'vitest';
import { EvtEventSchema } from './events.js';

describe('EvtEventSchema', () => {
  it('parses a valid event', () => {
    const event = EvtEventSchema.parse({
      type: 'backoffice.invoice.draft_created',
      actor: 'finance-agent',
      scope: 'company',
      payload: { invoiceId: '123', amount: 500 },
    });
    expect(event.type).toBe('backoffice.invoice.draft_created');
    expect(event.actor).toBe('finance-agent');
  });

  it('requires type, actor, and payload', () => {
    expect(() => EvtEventSchema.parse({})).toThrow();
    expect(() => EvtEventSchema.parse({ type: 'test' })).toThrow();
  });

  it('allows optional scope and timestamp', () => {
    const event = EvtEventSchema.parse({
      type: 'backoffice.digest.published',
      actor: 'chief-of-staff',
      payload: {},
    });
    expect(event.scope).toBeUndefined();
    expect(event.timestamp).toBeUndefined();
  });
});
