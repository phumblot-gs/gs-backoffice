#!/usr/bin/env node
/**
 * Verify that the agent bridge emits the audit + evolution events (PR #82), using
 * the SAME read path as production (a durable, server-side-filtered EVT queue — NOT
 * `/v1/events/query`, which is unreliable on the shared staging stream).
 *
 * A queue only captures events published AFTER it exists, so this is a 2-step flow:
 *
 *   1. Create the verification queue (run BEFORE the self-evolution run):
 *        EVT_API_URL=… EVT_API_KEY=… node scripts/verify-evolution-events.mjs ensure
 *   2. Trigger a self-evolution run that invokes bridge tools (create_child_issue /
 *      open_pr / report_progress / get_issue …).
 *   3. Drain + print what the queue captured (acks as it goes):
 *        EVT_API_URL=… EVT_API_KEY=… node scripts/verify-evolution-events.mjs drain
 *
 * Reads creds from the environment — never prints the key. Read-only w.r.t. business
 * data; it only creates/consumes its own dedicated `gs-queue-verify-evolution` queue.
 */
const MODE = (process.argv[2] || 'drain').trim();
const baseUrl = (process.env.EVT_API_URL || '').trim().replace(/\/$/, '');
const apiKey = (process.env.EVT_API_KEY || '').trim();
const QUEUE_NAME = 'gs-queue-verify-evolution';

if (!baseUrl || !apiKey) {
  console.error('Set EVT_API_URL and EVT_API_KEY in the environment first.');
  process.exit(2);
}
if (!['ensure', 'drain'].includes(MODE)) {
  console.error(`Usage: node scripts/verify-evolution-events.mjs [ensure|drain]`);
  process.exit(2);
}

const EVENT_TYPES = [
  'backoffice.audit.tool_invoked',
  'backoffice.evolution.step_created',
  'backoffice.evolution.pr_opened',
  'backoffice.evolution.completed',
  'backoffice.evolution.escalated',
];

const auth = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };

async function api(url, init) {
  const res = await fetch(url.startsWith('http') ? url : `${baseUrl}${url}`, {
    ...init,
    headers: auth,
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}: ${raw.slice(0, 300)}`);
  return raw ? JSON.parse(raw) : {};
}

async function getQueue() {
  try {
    return await api(`/v1/queues/${QUEUE_NAME}`, { method: 'GET' });
  } catch (err) {
    if (String(err).includes('HTTP 404')) return null;
    throw err;
  }
}

if (MODE === 'ensure') {
  const existing = await getQueue();
  const queue =
    existing ??
    (await api('/v1/queues', {
      method: 'POST',
      body: JSON.stringify({
        name: QUEUE_NAME,
        filters: { eventTypes: EVENT_TYPES },
        config: { maxMessages: 10, waitTimeSeconds: 20, visibilityTimeout: 60, retentionPeriod: 604800 },
      }),
    }));
  console.log(`Queue "${QUEUE_NAME}" ready (status: ${queue.status ?? '?'}).`);
  console.log('Subscribed to:');
  for (const t of EVENT_TYPES) console.log(`  • ${t}`);
  console.log('\nNow trigger a self-evolution run, then re-run with `drain`.');
  process.exit(0);
}

// drain
const queue = await getQueue();
if (!queue) {
  console.error(`Queue "${QUEUE_NAME}" does not exist — run \`ensure\` first (before the run).`);
  process.exit(1);
}
const messagesUrl = queue.endpoints?.messages;
if (!messagesUrl) {
  console.error('Queue has no messages endpoint.');
  process.exit(1);
}

const byType = Object.fromEntries(EVENT_TYPES.map((t) => [t, 0]));
const rows = [];
// Poll a few empty rounds before giving up (long-poll waitTimeSeconds covers latency).
let emptyRounds = 0;
while (emptyRounds < 3) {
  const { messages = [] } = await api(messagesUrl, { method: 'GET' });
  if (messages.length === 0) {
    emptyRounds++;
    continue;
  }
  emptyRounds = 0;
  const handles = [];
  for (const m of messages) {
    const e = m.body ?? {};
    if (e.eventType in byType) byType[e.eventType]++;
    rows.push(e);
    handles.push(m.receiptHandle);
  }
  if (handles.length) await api(messagesUrl, { method: 'DELETE', body: JSON.stringify({ receiptHandles: handles }) });
}

console.log(`Drained ${rows.length} audit/evolution event(s) from "${QUEUE_NAME}".\n`);
for (const t of EVENT_TYPES) console.log(`  ${byType[t] ? '✓' : '·'} ${t.padEnd(36)} ${byType[t]}`);
console.log('\nDetail:');
for (const e of rows) {
  const p = e.payload ?? {};
  const detail =
    e.eventType === 'backoffice.audit.tool_invoked'
      ? `${p.tool} (${p.category}) ok=${p.ok} issue=${p.issueId || '-'}`
      : `${p.identifier || p.childIdentifier || p.number || ''} ${p.url || p.status || ''}`.trim();
  console.log(`  ${(e.timestamp || '').slice(11, 19)}  ${e.eventType.padEnd(36)} ${detail}`);
}
