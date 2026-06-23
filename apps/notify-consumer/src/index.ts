import pino from 'pino';
import { EvtClient } from '@gs-backoffice/evt-client';
import type { EvtEvent } from '@gs-backoffice/core';

const logger = pino({ name: 'notify-consumer' });

const EVT_API_URL = process.env.EVT_API_URL;
const EVT_API_KEY = process.env.EVT_API_KEY;
// Durable, server-side-filtered queue: no event is missed regardless of volume or restarts.
const QUEUE_NAME = process.env.NOTIFY_QUEUE_NAME ?? 'backoffice-notify';

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

export interface RenderedMessage {
  scope: string | null;
  /** A Google Chat message body — either { text } or { cardsV2 }. */
  body: Record<string, unknown>;
}

/** Render an EVT event into a Google Chat message body, or null if it should be ignored. */
export function renderMessage(event: EvtEvent): RenderedMessage | null {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  switch (event.eventType) {
    case 'backoffice.approval.requested': {
      // Skip the PluginManager audit event (same type, no business payload).
      if (!p.ticketId || !p.processCode) return null;
      // Use a card with a button: the <url|label> text syntax does not render
      // reliably for long encoded URLs, and a button is the documented approach.
      const widgets: Record<string, unknown>[] = [];
      if (p.summary) widgets.push({ textParagraph: { text: `<b>${p.summary}</b>` } });
      widgets.push({ textParagraph: { text: `Requested by <b>${p.requestedBy}</b>` } });
      if (p.approveUrl) {
        widgets.push({
          buttonList: {
            buttons: [
              {
                text: `Review ${p.ticketId}`,
                onClick: { openLink: { url: String(p.approveUrl) } },
              },
            ],
          },
        });
      }
      return {
        scope: (p.scope as string) ?? null,
        body: {
          cardsV2: [
            {
              cardId: `approval-${p.ticketId}`,
              card: {
                header: {
                  title: '🔒 Approval needed',
                  subtitle: p.projectName
                    ? `${p.projectName} · ${p.processCode}`
                    : `Process: ${p.processCode}`,
                },
                sections: [{ widgets }],
              },
            },
          ],
        },
      };
    }
    case 'backoffice.approval.decided': {
      // Skip the PluginManager audit event (same type, no business payload) — this is
      // what produced the "Approval undefined (undefined) …" artifact.
      if (!p.ticketId || !p.decision) return null;
      const icon = p.decision === 'approved' ? '✅' : '⛔';
      return {
        scope: (p.scope as string) ?? null,
        body: {
          text:
            `${icon} Approval *${p.ticketId}* (\`${p.processCode}\`) ${p.decision} by ${p.approver}.` +
            (p.runTicket ? ` Running as ${p.runTicket}.` : ''),
        },
      };
    }
    case 'backoffice.notify.google_chat':
      // Generic passthrough: payload carries the message text + optional scope/channel.
      return typeof p.text === 'string'
        ? { scope: (p.scope as string) ?? (p.channel as string) ?? null, body: { text: p.text } }
        : null;
    default:
      return null;
  }
}

async function postToChat(url: string, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(
      `Google Chat webhook responded ${res.status}: ${(await res.text()).slice(0, 200)}`,
    );
  }
}

const WEBHOOKS = parseWebhooks(process.env.GOOGLE_CHAT_WEBHOOKS);

/**
 * Process one event. Returns whether the message may be acknowledged (removed from
 * the queue). We ACK when there is nothing to retry — successfully posted, or
 * deliberately dropped (audit/unknown event, or no webhook configured: redelivering
 * forever would only spam). We DON'T ack on a transient Google Chat failure, so the
 * message is redelivered after the visibility timeout (at-least-once).
 */
async function handleEvent(event: EvtEvent): Promise<boolean> {
  const rendered = renderMessage(event);
  if (!rendered) return true; // audit/unknown event — nothing to send
  const target = webhookForScope(rendered.scope, WEBHOOKS);
  if (!target) {
    logger.warn(
      { eventId: event.eventId, scope: rendered.scope },
      'No Google Chat webhook configured for this scope — dropping (set GOOGLE_CHAT_WEBHOOKS)',
    );
    return true;
  }
  try {
    await postToChat(target.url, rendered.body);
    logger.info(
      { eventId: event.eventId, eventType: event.eventType, channel: target.channel },
      'Notification posted to Google Chat',
    );
    return true;
  } catch (err) {
    logger.error(
      { eventId: event.eventId, error: err },
      'Failed to post to Google Chat — leaving message for redelivery',
    );
    return false;
  }
}

async function main(): Promise<void> {
  if (!EVT_API_URL || !EVT_API_KEY) {
    logger.error('EVT_API_URL / EVT_API_KEY not set — cannot consume events');
    process.exit(1);
  }
  const client = new EvtClient({ apiKey: EVT_API_KEY, baseUrl: EVT_API_URL });

  // Ensure our durable, server-side-filtered queue exists, then consume + ack it.
  const queue = await client.ensureQueue({
    name: QUEUE_NAME,
    filters: { eventTypes: SUBSCRIBED_EVENT_TYPES },
    config: {
      maxMessages: 10,
      waitTimeSeconds: 20,
      visibilityTimeout: 60,
      retentionPeriod: 604800,
    },
  });
  const messagesUrl = queue.endpoints?.messages;
  if (!messagesUrl) {
    logger.error({ queue: QUEUE_NAME }, 'Queue has no messages endpoint — cannot consume');
    process.exit(1);
  }
  logger.info(
    { queue: QUEUE_NAME, subscribed: SUBSCRIBED_EVENT_TYPES, channels: Object.keys(WEBHOOKS) },
    'Notify consumer started — consuming the EVT queue',
  );
  if (Object.keys(WEBHOOKS).length === 0) {
    logger.warn(
      'GOOGLE_CHAT_WEBHOOKS is empty — notifications will be logged and dropped until configured',
    );
  }

  // At-least-once delivery → guard against a redelivered message double-posting
  // within a session (e.g. post succeeded but ack failed).
  const SEEN_MAX = 1000;
  const handled = new Set<string>();
  for (;;) {
    try {
      const messages = await client.receiveMessages(messagesUrl);
      const toAck: string[] = [];
      for (const msg of messages) {
        const id = msg.body?.eventId ?? msg.messageId;
        if (handled.has(id)) {
          toAck.push(msg.receiptHandle); // already done — just ack the duplicate
          continue;
        }
        const ack = await handleEvent(msg.body);
        if (ack) {
          toAck.push(msg.receiptHandle);
          handled.add(id);
          if (handled.size > SEEN_MAX) handled.delete(handled.values().next().value as string);
        }
      }
      await client.ackMessages(messagesUrl, toAck);
    } catch (err) {
      // Network/EVT blip — back off briefly and retry; unacked messages persist.
      logger.error({ error: err }, 'Queue receive/ack failed — retrying shortly');
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

// Only run the poll loop when executed directly (not when imported by tests).
if (process.env.NODE_ENV !== 'test') {
  main().catch((err) => {
    logger.fatal({ error: err }, 'Notify consumer crashed');
    process.exit(1);
  });
}
