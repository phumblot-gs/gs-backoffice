import pino from 'pino';
import { EvtClient } from '@gs-backoffice/evt-client';
import type { EvtEvent } from '@gs-backoffice/core';

const logger = pino({ name: 'notify-consumer' });

const EVT_API_URL = process.env.EVT_API_URL;
const EVT_API_KEY = process.env.EVT_API_KEY;
const POLL_INTERVAL = parseInt(process.env.NOTIFY_POLL_INTERVAL_MS ?? '5000', 10);

// Event types the consumer renders into Google Chat messages. Add more here as
// other agents start publishing notify-worthy events.
export const SUBSCRIBED_EVENT_TYPES = [
  'backoffice.approval.requested',
  'backoffice.approval.decided',
  'backoffice.notify.google_chat',
];

/**
 * Webhook routing map (one Google Chat channel per scope), supplied as a JSON
 * object in the GOOGLE_CHAT_WEBHOOKS secret, e.g.
 *   {"general":"https://chat.googleapis.com/...","finance":"https://chat.googleapis.com/..."}
 * Editing this one secret value adds/changes channels — no task-def change needed.
 */
export function parseWebhooks(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string' && v.trim()) out[k.toLowerCase()] = v.trim();
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Resolve the Google Chat webhook for a business scope: the scope's own channel,
 * else the `general` channel; null if neither is configured (the consumer then
 * logs and skips — degrade gracefully when webhooks aren't set up yet).
 */
export function webhookForScope(
  scope: string | null | undefined,
  webhooks: Record<string, string>,
): { url: string; channel: string } | null {
  const normalized = ((scope && scope.trim()) || 'general').toLowerCase();
  if (webhooks[normalized]) return { url: webhooks[normalized], channel: normalized };
  if (webhooks['general']) return { url: webhooks['general'], channel: 'general' };
  return null;
}

/** Render an EVT event into a Google Chat message, or null if it should be ignored. */
export function renderMessage(event: EvtEvent): { text: string; scope: string | null } | null {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  switch (event.eventType) {
    case 'backoffice.approval.requested':
      return {
        scope: (p.scope as string) ?? null,
        text:
          `🔒 *Approval needed* — process \`${p.processCode}\` requested by ${p.requestedBy}.\n` +
          `Review & decide: ${p.approveUrl}\n_Ticket ${p.ticketId}_`,
      };
    case 'backoffice.approval.decided': {
      const icon = p.decision === 'approved' ? '✅' : '⛔';
      return {
        scope: (p.scope as string) ?? null,
        text:
          `${icon} Approval *${p.ticketId}* (\`${p.processCode}\`) ${p.decision} by ${p.approver}.` +
          (p.runTicket ? ` Running as ${p.runTicket}.` : ''),
      };
    }
    case 'backoffice.notify.google_chat':
      // Generic passthrough: payload carries the message text + optional scope/channel.
      return typeof p.text === 'string'
        ? { scope: (p.scope as string) ?? (p.channel as string) ?? null, text: p.text }
        : null;
    default:
      return null;
  }
}

async function postToChat(url: string, text: string): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    throw new Error(
      `Google Chat webhook responded ${res.status}: ${(await res.text()).slice(0, 200)}`,
    );
  }
}

const WEBHOOKS = parseWebhooks(process.env.GOOGLE_CHAT_WEBHOOKS);

async function handleEvent(event: EvtEvent): Promise<void> {
  const rendered = renderMessage(event);
  if (!rendered) return;
  const target = webhookForScope(rendered.scope, WEBHOOKS);
  if (!target) {
    logger.warn(
      { eventId: event.eventId, scope: rendered.scope },
      'No Google Chat webhook configured for this scope — skipping (set GOOGLE_CHAT_WEBHOOKS)',
    );
    return;
  }
  try {
    await postToChat(target.url, rendered.text);
    logger.info(
      { eventId: event.eventId, eventType: event.eventType, channel: target.channel },
      'Notification posted to Google Chat',
    );
  } catch (err) {
    logger.error(
      { eventId: event.eventId, error: err },
      'Failed to post notification to Google Chat',
    );
  }
}

async function main(): Promise<void> {
  if (!EVT_API_URL || !EVT_API_KEY) {
    logger.error('EVT_API_URL / EVT_API_KEY not set — cannot consume events');
    process.exit(1);
  }
  const client = new EvtClient({ apiKey: EVT_API_KEY, baseUrl: EVT_API_URL });
  logger.info(
    {
      subscribed: SUBSCRIBED_EVENT_TYPES,
      intervalMs: POLL_INTERVAL,
      channels: Object.keys(WEBHOOKS),
    },
    'Notify consumer started — polling EVT for notify-worthy events',
  );
  if (Object.keys(WEBHOOKS).length === 0) {
    logger.warn(
      'GOOGLE_CHAT_WEBHOOKS is empty — notifications will be logged and skipped until configured',
    );
  }
  // In-memory dedup guards against the poll cursor re-emitting an event within a session.
  const seen = new Set<string>();
  for await (const event of client.poll({
    filters: { eventTypes: SUBSCRIBED_EVENT_TYPES },
    interval: POLL_INTERVAL,
  })) {
    if (event.eventId) {
      if (seen.has(event.eventId)) continue;
      seen.add(event.eventId);
    }
    await handleEvent(event);
  }
}

// Only run the poll loop when executed directly (not when imported by tests).
if (process.env.NODE_ENV !== 'test') {
  main().catch((err) => {
    logger.fatal({ error: err }, 'Notify consumer crashed');
    process.exit(1);
  });
}
