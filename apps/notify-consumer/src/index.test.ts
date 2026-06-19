import { describe, it, expect } from 'vitest';
import {
  renderMessage,
  webhookForScope,
  parseWebhooks,
  selectFreshEvents,
  SUBSCRIBED_EVENT_TYPES,
} from './index.js';
import type { EvtEvent } from '@gs-backoffice/core';

describe('selectFreshEvents (EVT head tailing)', () => {
  const ev = (id: string, ts: string): EvtEvent => ({
    eventId: id,
    eventType: 'backoffice.approval.requested',
    timestamp: ts,
    source: { application: 'gs-backoffice', version: '0.1.0', environment: 'staging' },
    actor: { userId: 'u', accountId: '16' },
    scope: { accountId: '16', resourceType: 'approval', resourceId: 'x' },
    payload: {},
  });
  // Query returns NEWEST-first.
  const newestFirst = [ev('b', '2026-06-18T23:05:00Z'), ev('a', '2026-06-18T23:00:00Z')];

  it('establishes a baseline on first call without replaying history', () => {
    const r = selectFreshEvents(newestFirst, null, new Set());
    expect(r.fresh).toHaveLength(0);
    expect(r.lastTs).toBe('2026-06-18T23:05:00Z');
  });

  it('emits only events newer than the baseline, in chronological order', () => {
    const seen = new Set<string>();
    const r = selectFreshEvents(
      [ev('c', '2026-06-18T23:10:00Z'), ev('b', '2026-06-18T23:05:00Z')],
      '2026-06-18T23:05:00Z',
      seen,
    );
    // 'b' is at the boundary (== lastTs) but not in `seen` yet → emitted once; 'c' is newer.
    expect(r.fresh.map((e) => e.eventId)).toEqual(['b', 'c']);
    expect(r.lastTs).toBe('2026-06-18T23:10:00Z');
  });

  it('does not re-emit an already-seen boundary event', () => {
    const seen = new Set(['b']);
    const r = selectFreshEvents(
      [ev('c', '2026-06-18T23:10:00Z'), ev('b', '2026-06-18T23:05:00Z')],
      '2026-06-18T23:05:00Z',
      seen,
    );
    expect(r.fresh.map((e) => e.eventId)).toEqual(['c']);
  });
});

const base = {
  source: { application: 'gs-backoffice', version: '0.1.0', environment: 'staging' as const },
  actor: { userId: 'u1', accountId: '16' },
  scope: { accountId: '16', resourceType: 'approval', resourceId: 'GRA-5' },
};

describe('parseWebhooks', () => {
  it('parses a JSON scope→url map (lowercasing scopes, dropping blanks)', () => {
    expect(
      parseWebhooks('{"General":"https://chat/general","finance":"https://chat/fin","x":""}'),
    ).toEqual({ general: 'https://chat/general', finance: 'https://chat/fin' });
  });
  it('returns {} for missing or invalid JSON', () => {
    expect(parseWebhooks(undefined)).toEqual({});
    expect(parseWebhooks('not json')).toEqual({});
    expect(parseWebhooks('"a string"')).toEqual({});
  });
});

describe('webhookForScope', () => {
  const webhooks = { general: 'https://chat/general', customer_success: 'https://chat/cs' };

  it('routes a scope to its own channel', () => {
    expect(webhookForScope('customer_success', webhooks)).toEqual({
      url: 'https://chat/cs',
      channel: 'customer_success',
    });
  });

  it('falls back to general when the scope channel is not configured', () => {
    expect(webhookForScope('sales', webhooks)).toEqual({
      url: 'https://chat/general',
      channel: 'general',
    });
  });

  it('treats null/empty scope as general', () => {
    expect(webhookForScope(null, webhooks)?.channel).toBe('general');
  });

  it('returns null when nothing is configured (degrade gracefully)', () => {
    expect(webhookForScope('sales', {})).toBeNull();
  });
});

describe('renderMessage', () => {
  it('renders an approval request with the deep-link and scope', () => {
    const e: EvtEvent = {
      ...base,
      eventType: 'backoffice.approval.requested',
      payload: {
        scope: 'finance',
        ticketId: 'GRA-9',
        processCode: 'pay-supplier',
        requestedBy: 'alice@grand-shooting.com',
        approveUrl: 'https://claude.ai/new?q=...',
      },
    };
    const m = renderMessage(e);
    expect(m?.scope).toBe('finance');
    expect(m?.text).toContain('pay-supplier');
    // Clickable "Ticket GRA-9" via Google Chat <url|label> syntax, not a bare URL.
    expect(m?.text).toContain('<https://claude.ai/new?q=...|Ticket GRA-9>');
  });

  it('ignores the audit event (same type, no business payload) for requested/decided', () => {
    // PluginManager audit events reuse the tool's evtEventType with a {tool,input,isError} payload.
    const auditReq: EvtEvent = {
      ...base,
      eventType: 'backoffice.approval.requested',
      payload: { tool: 'henri_start_workflow', isError: false },
    };
    const auditDec: EvtEvent = {
      ...base,
      eventType: 'backoffice.approval.decided',
      payload: { tool: 'henri_approve', input: { ticketId: 'GRA-8' }, isError: false },
    };
    expect(renderMessage(auditReq)).toBeNull();
    expect(renderMessage(auditDec)).toBeNull();
  });

  it('renders an approved decision', () => {
    const e: EvtEvent = {
      ...base,
      eventType: 'backoffice.approval.decided',
      payload: {
        ticketId: 'GRA-9',
        processCode: 'pay-supplier',
        decision: 'approved',
        approver: 'bob@grand-shooting.com',
        runTicket: 'GRA-10',
      },
    };
    expect(renderMessage(e)?.text).toContain('✅');
    expect(renderMessage(e)?.text).toContain('GRA-10');
  });

  it('passes through a generic notify event', () => {
    const e: EvtEvent = {
      ...base,
      eventType: 'backoffice.notify.google_chat',
      payload: { text: 'hello world', scope: 'engineering' },
    };
    expect(renderMessage(e)).toEqual({ text: 'hello world', scope: 'engineering' });
  });

  it('ignores unknown event types', () => {
    const e: EvtEvent = { ...base, eventType: 'backoffice.something.else', payload: {} };
    expect(renderMessage(e)).toBeNull();
  });

  it('subscribes to the approval lifecycle + generic notify', () => {
    expect(SUBSCRIBED_EVENT_TYPES).toContain('backoffice.approval.requested');
    expect(SUBSCRIBED_EVENT_TYPES).toContain('backoffice.notify.google_chat');
  });
});
