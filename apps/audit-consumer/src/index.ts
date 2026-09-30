import { setTimeout as delay } from 'node:timers/promises';
import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { EvtClient } from '@gs-backoffice/evt-client';
import pino from 'pino';
import { AuditWorker } from './worker.js';
const logger = pino({ name: 'audit-consumer' });
const required = (key: string) => {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`Missing ${key}`);
  return value;
};
const queue = required('AUDIT_QUEUE_URL');
const dlq = required('AUDIT_DLQ_URL');
const sqs = new SQSClient({ region: process.env.AWS_REGION || 'eu-west-1', maxAttempts: 1 });
const evt = new EvtClient({
  baseUrl: required('EVT_API_URL'),
  apiKey: required('EVT_API_KEY'),
  retries: 0,
  timeout: 8000,
});
const stop = new AbortController();
process.on('SIGTERM', () => stop.abort());
process.on('SIGINT', () => stop.abort());
const worker = new AuditWorker({
  receive: async () =>
    (
      await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queue,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: 20,
          VisibilityTimeout: 60,
        }),
        { abortSignal: AbortSignal.any([stop.signal, AbortSignal.timeout(25000)]) },
      )
    ).Messages ?? [],
  deliver: (event) => evt.publish(event),
  remove: (receipt) =>
    sqs.send(new DeleteMessageCommand({ QueueUrl: queue, ReceiptHandle: receipt }), {
      abortSignal: AbortSignal.timeout(8000),
    }),
  defer: (receipt, seconds) =>
    sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: queue,
        ReceiptHandle: receipt,
        VisibilityTimeout: seconds,
      }),
      { abortSignal: AbortSignal.timeout(8000) },
    ),
  quarantine: (body) =>
    sqs.send(new SendMessageCommand({ QueueUrl: dlq, MessageBody: body }), {
      abortSignal: AbortSignal.timeout(8000),
    }),
  sleep: (ms) => delay(ms, undefined, { signal: stop.signal }),
  log: (signal, fields) => logger.info(fields ?? {}, signal),
});
// Emitted even while the EVT circuit is open; a separate alarm watches its absence.
const heartbeat = setInterval(() => logger.info('AUDIT_CONSUMER_HEARTBEAT'), 60000);
logger.info('AUDIT_CONSUMER_HEARTBEAT');
try {
  while (!stop.signal.aborted) {
    try {
      await worker.tick();
    } catch {
      if (stop.signal.aborted) break;
      logger.error('AUDIT_CONSUMER_FAILURE'); // No message bodies or credentials in operational logs.
      await delay(10000, undefined, { signal: stop.signal }).catch(() => {});
    }
  }
} finally {
  clearInterval(heartbeat);
  sqs.destroy();
}
