/**
 * CloudWatch alarm → Google Chat forwarder.
 *
 * Subscribed to the gs-backoffice alerts SNS topic. Deliberately posts to the Chat
 * webhook DIRECTLY rather than publishing a `backoffice.notify.google_chat` event
 * through EVT → notify-consumer like the rest of the system: the notify-consumer
 * runs on the very ECS cluster these alarms watch, so routing alerts through it
 * would leave us silent exactly when things are broken. An alarm channel must not
 * share fate with what it monitors.
 *
 * Runtime deps: none beyond the Node 22 runtime (global fetch) and the AWS SDK v3
 * bundled with it, so the deployment package stays a single file.
 */
/** Cached across warm invocations; alarms are bursty and the secret rarely changes. */
let webhooksPromise;

/**
 * Read the {scope: url} webhook map from the app secret (same key the notify-consumer
 * uses). The AWS SDK is imported lazily so this module stays loadable — and the pure
 * rendering below stays testable — outside the Lambda runtime.
 */
function loadWebhooks() {
  webhooksPromise ??= (async () => {
    const { SecretsManagerClient, GetSecretValueCommand } =
      await import('@aws-sdk/client-secrets-manager');
    const res = await new SecretsManagerClient({}).send(
      new GetSecretValueCommand({ SecretId: process.env.APP_SECRETS_ARN }),
    );
    const app = JSON.parse(res.SecretString ?? '{}');
    const raw = app.GOOGLE_CHAT_WEBHOOKS;
    const parsed = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw ?? {});
    const out = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string' && v.trim()) out[k.toLowerCase()] = v.trim();
    }
    return out;
  })();
  return webhooksPromise;
}

const STATE_PREFIX = {
  ALARM: '🚨 ALARME',
  OK: '✅ Retour à la normale',
  INSUFFICIENT_DATA: '❓ Données insuffisantes',
};

/** Render one SNS message as Chat text. Exported shape kept pure for readability. */
export function renderAlarm(message, region) {
  let alarm;
  try {
    alarm = JSON.parse(message);
  } catch {
    return `🔔 Alerte gs-backoffice :\n${String(message).slice(0, 1500)}`;
  }
  if (!alarm?.AlarmName) return `🔔 Alerte gs-backoffice :\n${message.slice(0, 1500)}`;

  const state = STATE_PREFIX[alarm.NewStateValue] ?? `🔔 ${alarm.NewStateValue}`;
  const url = `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#alarmsV2:alarm/${encodeURIComponent(alarm.AlarmName)}`;
  const lines = [
    `${state} — <${url}|${alarm.AlarmName}>`,
    alarm.AlarmDescription ? `_${alarm.AlarmDescription}_` : null,
    alarm.NewStateReason ? `Raison : ${String(alarm.NewStateReason).slice(0, 500)}` : null,
    alarm.StateChangeTime ? `Depuis : ${alarm.StateChangeTime}` : null,
  ];
  return lines.filter(Boolean).join('\n');
}

async function postToChat(url, text) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    throw new Error(`Google Chat responded ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

export async function handler(event) {
  const webhooks = await loadWebhooks();
  // Alarms go to a dedicated `alerts` channel when one is configured, else `general`
  // — same scope→channel convention as the notify-consumer.
  const target = webhooks.alerts ?? webhooks.general;
  const region = process.env.AWS_REGION ?? 'eu-west-1';

  if (!target) {
    // Nothing to post to. Fail loudly in the logs rather than dropping silently:
    // a swallowed alert is the exact failure mode this whole change exists to kill.
    console.error(
      'BACKOFFICE_JOB_FAILURE alarm-forwarder: no Google Chat webhook configured (need "alerts" or "general" in GOOGLE_CHAT_WEBHOOKS)',
    );
    throw new Error('alarm-forwarder: no Google Chat webhook configured');
  }

  for (const record of event.Records ?? []) {
    const text = renderAlarm(record.Sns?.Message ?? '', region);
    await postToChat(target, text);
    console.log(
      JSON.stringify({ msg: 'alarm forwarded to Google Chat', messageId: record.Sns?.MessageId }),
    );
  }
}
