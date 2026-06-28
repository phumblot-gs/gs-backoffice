import { describe, it, expect } from 'vitest';
import { renderMessage, webhookForScope, parseWebhooks, SUBSCRIBED_EVENT_TYPES } from './index.js';
import type { EvtEvent } from '@gs-backoffice/core';

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

  it('routes scope leadership to the leadership channel, falling back to general', () => {
    expect(
      webhookForScope('leadership', { leadership: 'https://lead', general: 'https://gen' }),
    ).toEqual({
      url: 'https://lead',
      channel: 'leadership',
    });
    expect(webhookForScope('leadership', { general: 'https://gen' })).toEqual({
      url: 'https://gen',
      channel: 'general',
    });
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
        approvalId: 'appr-123',
        processCode: 'pay-supplier',
        requestedBy: 'alice@grand-shooting.com',
        approveUrl: 'https://claude.ai/new?q=...',
      },
    };
    const m = renderMessage(e);
    expect(m?.scope).toBe('finance');
    // Rendered as a card with a "Review & decide" button that opens the deep-link.
    const card = (m?.body.cardsV2 as Array<{ card: Record<string, unknown> }>)[0].card as {
      header: { subtitle: string };
      sections: Array<{ widgets: Array<Record<string, unknown>> }>;
    };
    expect(card.header.subtitle).toContain('pay-supplier');
    const button = (
      card.sections[0].widgets.find((w) => 'buttonList' in w)!.buttonList as {
        buttons: Array<{ text: string; onClick: { openLink: { url: string } } }>;
      }
    ).buttons[0];
    expect(button.text).toBe('Review & decide');
    expect(button.onClick.openLink.url).toBe('https://claude.ai/new?q=...');
  });

  it('ignores audit events (dedicated type, not a business event)', () => {
    // Audit events now use the dedicated backoffice.audit.tool_invoked type.
    const audit: EvtEvent = {
      ...base,
      eventType: 'backoffice.audit.tool_invoked',
      payload: { tool: 'henri_approve', category: 'approval.decided', isError: false },
    };
    expect(renderMessage(audit)).toBeNull();
  });

  it('defensively skips a business event missing its payload (belt-and-suspenders)', () => {
    const bad: EvtEvent = {
      ...base,
      eventType: 'backoffice.approval.decided',
      payload: { tool: 'henri_approve' },
    };
    expect(renderMessage(bad)).toBeNull();
  });

  it('renders an approved decision', () => {
    const e: EvtEvent = {
      ...base,
      eventType: 'backoffice.approval.decided',
      payload: {
        approvalId: 'appr-123',
        processCode: 'pay-supplier',
        decision: 'approved',
        approver: 'bob@grand-shooting.com',
        runTicket: 'GRA-10',
      },
    };
    expect(renderMessage(e)?.body.text).toContain('✅');
    expect(renderMessage(e)?.body.text).toContain('GRA-10');
  });

  it('passes through a generic notify event', () => {
    const e: EvtEvent = {
      ...base,
      eventType: 'backoffice.notify.google_chat',
      payload: { text: 'hello world', scope: 'engineering' },
    };
    expect(renderMessage(e)).toEqual({ body: { text: 'hello world' }, scope: 'engineering' });
  });

  it('ignores unknown event types', () => {
    const e: EvtEvent = { ...base, eventType: 'backoffice.something.else', payload: {} };
    expect(renderMessage(e)).toBeNull();
  });

  it('subscribes to the approval lifecycle + generic notify', () => {
    expect(SUBSCRIBED_EVENT_TYPES).toContain('backoffice.approval.requested');
    expect(SUBSCRIBED_EVENT_TYPES).toContain('backoffice.notify.google_chat');
  });

  it('does NOT subscribe to backoffice.budget.snapshot (BI data, not a chat notif — GRA-42 Step 3)', () => {
    expect(SUBSCRIBED_EVENT_TYPES).not.toContain('backoffice.budget.snapshot');
  });
});
