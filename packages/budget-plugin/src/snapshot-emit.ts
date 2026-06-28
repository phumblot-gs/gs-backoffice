/**
 * Publish the daily budget snapshot as ONE aggregated `backoffice.budget.snapshot` event
 * via the shared EvtClient. Mirrors notify.ts, but a different event type + payload: this is
 * BI/analytics data (every agent + project for the day), NOT a chat notification — the
 * notify-consumer deliberately does NOT subscribe to it (see apps/notify-consumer Step 3 test).
 *
 * Scope: resourceType "budget_snapshot", resourceId = reportDate (one event per day).
 * Best-effort: returns true on publish, false on any missing config or error; never throws.
 */
import { EvtClient } from '@gs-backoffice/evt-client';
import { createBackofficeEvent } from '@gs-backoffice/core';
import type { SnapshotPayload } from './snapshot.js';

export async function emitBudgetSnapshot(
  payload: SnapshotPayload,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  const baseUrl = (env.EVT_API_URL || '').trim();
  const apiKey = (env.EVT_API_KEY || '').trim();
  const accountId = (env.EVT_ACCOUNT_ID || '').trim();
  if (!baseUrl || !apiKey || !accountId) return false;
  const event = createBackofficeEvent(
    'backoffice.budget.snapshot',
    { userId: 'budget-snapshot', accountId, role: 'system' },
    { accountId, resourceType: 'budget_snapshot', resourceId: payload.reportDate },
    payload as unknown as Record<string, unknown>,
    env.NODE_ENV === 'production' ? 'production' : 'staging',
  );
  try {
    await new EvtClient({ baseUrl, apiKey }).publish(event);
    return true;
  } catch {
    return false;
  }
}
