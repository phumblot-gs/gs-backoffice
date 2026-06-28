#!/usr/bin/env node
/**
 * Emit ONE backoffice.* event to EVT from CI — used to record the go-live acts (an
 * evolution PR merged, a deploy completed) in the audit trail, which otherwise live only
 * in GitHub/Actions logs (audit gap G2).
 *
 * Standalone: no workspace deps, builds the same envelope as @gs-backoffice/core's
 * createBackofficeEvent. BEST-EFFORT — a missing config or failed publish logs a warning
 * and exits 0, so an EVT hiccup never fails a deploy. The EVT server assigns eventId.
 *
 * Env:
 *   EVT_API_URL, EVT_API_KEY, EVT_ACCOUNT_ID   creds (absent → log + skip)
 *   EVT_EVENT_TYPE                              required, e.g. backoffice.deploy.completed
 *   EVT_RESOURCE_TYPE  (default "deployment"), EVT_RESOURCE_ID, EVT_ACTOR (default github-actions)
 *   EVT_ENVIRONMENT    (default "staging")
 *   EVT_PAYLOAD        JSON string (the event payload)
 */
const url = (process.env.EVT_API_URL || '').trim().replace(/\/$/, '');
const apiKey = (process.env.EVT_API_KEY || '').trim();
const accountId = (process.env.EVT_ACCOUNT_ID || '').trim();
const eventType = (process.env.EVT_EVENT_TYPE || '').trim();
const environment = (process.env.EVT_ENVIRONMENT || 'staging').trim();

if (!eventType) {
  console.error('emit-evt: EVT_EVENT_TYPE is required');
  process.exit(1);
}
let payload = {};
try {
  payload = JSON.parse(process.env.EVT_PAYLOAD || '{}');
} catch {
  payload = { raw: process.env.EVT_PAYLOAD ?? null };
}

const event = {
  eventType,
  timestamp: new Date().toISOString(),
  source: { application: 'gs-backoffice-ci', version: '0.1.0', environment },
  actor: { userId: (process.env.EVT_ACTOR || 'github-actions').trim(), accountId, role: 'ci' },
  scope: {
    accountId,
    resourceType: (process.env.EVT_RESOURCE_TYPE || 'deployment').trim(),
    resourceId: (process.env.EVT_RESOURCE_ID || '').trim(),
  },
  payload,
};

if (!url || !apiKey || !accountId) {
  console.warn(`emit-evt: EVT creds absent — skipping publish. Event: ${JSON.stringify(event)}`);
  process.exit(0);
}

try {
  const res = await fetch(`${url}/v1/events`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  });
  const body = await res.text();
  if (!res.ok) {
    console.warn(
      `emit-evt: publish failed HTTP ${res.status}: ${body.slice(0, 200)} (best-effort — not failing the pipeline)`,
    );
    process.exit(0);
  }
  let id = '?';
  try {
    id = JSON.parse(body).eventId ?? '?';
  } catch {
    /* ignore */
  }
  console.log(`emit-evt: published ${eventType} (eventId: ${id})`);
} catch (err) {
  console.warn(`emit-evt: publish error — ${String(err)} (best-effort)`);
  process.exit(0);
}
