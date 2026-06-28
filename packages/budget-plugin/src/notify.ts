/**
 * Publish a budget alert to the Leadership Google Chat channel via the shared EvtClient.
 * Mirrors packages/sandbox-fly-sprites/src/digest.ts `emitChatNotify`, but scope = 'leadership'
 * (the notify-consumer routes scope → channel from the GOOGLE_CHAT_WEBHOOKS map).
 * Best-effort: returns true on publish, false on any missing config or error; never throws.
 */
import { EvtClient } from '@gs-backoffice/evt-client';
import { createBackofficeEvent } from '@gs-backoffice/core';

export async function emitLeadershipChatNotify(
  text: string,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  const baseUrl = (env.EVT_API_URL || '').trim();
  const apiKey = (env.EVT_API_KEY || '').trim();
  const accountId = (env.EVT_ACCOUNT_ID || '').trim();
  if (!baseUrl || !apiKey || !accountId) return false;
  const event = createBackofficeEvent(
    'backoffice.notify.google_chat',
    { userId: 'budget-alert-poll', accountId, role: 'system' },
    { accountId, resourceType: 'budget', resourceId: 'alert' },
    { text, scope: 'leadership' },
    env.NODE_ENV === 'production' ? 'production' : 'staging',
  );
  try {
    await new EvtClient({ baseUrl, apiKey }).publish(event);
    return true;
  } catch {
    return false;
  }
}
