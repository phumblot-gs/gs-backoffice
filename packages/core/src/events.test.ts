import { describe, it, expect } from 'vitest';
import { EvtEventSchema, createBackofficeEvent, BACKOFFICE_EVENT_TYPES } from './events.js';

const validEvent = {
  eventType: 'backoffice.invoice.draft_created',
  source: {
    application: 'gs-backoffice',
    version: '0.1.0',
    environment: 'development' as const,
  },
  actor: {
    userId: 'user-123',
    accountId: 'account-456',
    role: 'finance-agent',
  },
  scope: {
    accountId: 'account-456',
    resourceType: 'invoice',
    resourceId: 'inv-789',
  },
  payload: { amount: 500, currency: 'EUR' },
};

describe('EvtEventSchema', () => {
  it('parses a valid event', () => {
    const event = EvtEventSchema.parse(validEvent);
    expect(event.eventType).toBe('backoffice.invoice.draft_created');
    expect(event.source.application).toBe('gs-backoffice');
    expect(event.actor.userId).toBe('user-123');
    expect(event.scope.resourceType).toBe('invoice');
  });

  it('allows optional eventId and timestamp', () => {
    const event = EvtEventSchema.parse(validEvent);
    expect(event.eventId).toBeUndefined();
    expect(event.timestamp).toBeUndefined();
  });

  it('accepts eventId and timestamp when provided', () => {
    const event = EvtEventSchema.parse({
      ...validEvent,
      eventId: 'evt-001',
      timestamp: '2026-04-10T10:00:00Z',
    });
    expect(event.eventId).toBe('evt-001');
    expect(event.timestamp).toBe('2026-04-10T10:00:00Z');
  });

  it('requires source, actor, scope, payload', () => {
    expect(() => EvtEventSchema.parse({ eventType: 'test' })).toThrow();
    expect(() => EvtEventSchema.parse({ ...validEvent, source: undefined })).toThrow();
    expect(() => EvtEventSchema.parse({ ...validEvent, actor: undefined })).toThrow();
    expect(() => EvtEventSchema.parse({ ...validEvent, scope: undefined })).toThrow();
  });

  it('validates environment enum', () => {
    expect(() =>
      EvtEventSchema.parse({
        ...validEvent,
        source: { ...validEvent.source, environment: 'invalid' },
      }),
    ).toThrow();
  });

  it('allows optional metadata', () => {
    const event = EvtEventSchema.parse({
      ...validEvent,
      metadata: { traceId: 'trace-123' },
    });
    expect(event.metadata?.traceId).toBe('trace-123');
  });
});

describe('createBackofficeEvent', () => {
  it('creates a well-formed event', () => {
    const event = createBackofficeEvent(
      BACKOFFICE_EVENT_TYPES['invoice.draft_created'],
      { userId: 'agent-1', accountId: 'grafmaker' },
      { accountId: 'grafmaker', resourceType: 'invoice', resourceId: 'inv-1' },
      { amount: 1000 },
    );
    expect(event.eventType).toBe('backoffice.invoice.draft_created');
    expect(event.source.application).toBe('gs-backoffice');
    expect(event.source.environment).toBe('development');
    expect(EvtEventSchema.parse(event)).toBeDefined();
  });
});

describe('BACKOFFICE_EVENT_TYPES', () => {
  it('has all expected event types', () => {
    expect(BACKOFFICE_EVENT_TYPES['invoice.draft_created']).toBe(
      'backoffice.invoice.draft_created',
    );
    expect(BACKOFFICE_EVENT_TYPES['digest.published']).toBe('backoffice.digest.published');
    expect(BACKOFFICE_EVENT_TYPES['notify.google_chat']).toBe('backoffice.notify.google_chat');
  });
});
