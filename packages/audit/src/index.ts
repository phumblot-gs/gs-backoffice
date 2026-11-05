import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { randomUUID } from 'node:crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { EvtEventSchema, type EvtEvent } from '@gs-backoffice/core';

export type AuditPublisher = (event: EvtEvent) => Promise<void>;
export const AUDIT_ENQUEUE_FAILURE = 'BACKOFFICE_AUDIT_ENQUEUE_FAILURE';
export const auditConfigured = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.AUDIT_QUEUE_REQUIRED === 'true' || !!env.AUDIT_QUEUE_URL || !!env.AUDIT_ARCHIVE_BUCKET;

/** One stable ID for the archive, queue retries and EVT ingestion. Never include raw tool inputs. */
export function identifyAudit(event: EvtEvent): EvtEvent {
  return { ...event, eventId: event.eventId ?? randomUUID() };
}

export function createAuditPublisher(env: NodeJS.ProcessEnv = process.env): AuditPublisher {
  const queue = env.AUDIT_QUEUE_URL;
  const bucket = env.AUDIT_ARCHIVE_BUCKET;
  const region = env.AWS_REGION || 'eu-west-1';
  const s3 = new S3Client({ region, maxAttempts: 1 });
  const sqs = new SQSClient({ region, maxAttempts: 1 });
  const deposit: AuditPublisher = async (input) => {
    if (!queue || !bucket) throw new Error('Audit queue/archive not configured');
    const event = EvtEventSchema.parse(identifyAudit(input));
    if (!event.actor.accountId || !event.actor.userId || !event.scope.accountId)
      throw new Error('Audit identity not configured');
    const body = JSON.stringify(event);
    if (Buffer.byteLength(body) > 64 * 1024) throw new Error('Audit event exceeds 64 KiB');
    const key = `audit/${event.eventId}.json`;
    // One deadline across archive + enqueue, with no application retry on the caller path.
    const signal = AbortSignal.timeout(3000);
    const write = async () => {
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: 'application/json',
        }),
        { abortSignal: signal },
      );
      await sqs.send(new SendMessageCommand({ QueueUrl: queue, MessageBody: body }), {
        abortSignal: signal,
      });
    };
    // Also bound credential-provider stalls (abortSignal alone bounds HTTP, not credential lookup).
    await Promise.race([
      write(),
      new Promise<never>((_, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(new Error('Audit deposit deadline exceeded')),
          { once: true },
        );
      }),
    ]);
  };
  const metrics = new CloudWatchClient({ region, maxAttempts: 1 });
  return async (input) => {
    try {
      await deposit(input);
    } catch (error) {
      // Also alert for agent subprocesses whose stderr is not an ECS log stream.
      // Metrics are best effort and cannot extend the caller indefinitely.
      const signal = AbortSignal.timeout(500);
      if (env.AUDIT_METRIC_NAMESPACE)
        await Promise.race([
          metrics.send(
            new PutMetricDataCommand({
              Namespace: env.AUDIT_METRIC_NAMESPACE,
              MetricData: [{ MetricName: 'AuditDepositFailures', Value: 1, Unit: 'Count' }],
            }),
            { abortSignal: signal },
          ),
          new Promise<void>((resolve) =>
            signal.addEventListener('abort', () => resolve(), { once: true }),
          ),
        ]).catch(() => {});
      throw error;
    }
  };
}

export interface AuditedCallOptions<T> {
  event: EvtEvent;
  sensitive: boolean;
  publish: AuditPublisher;
  run: () => Promise<T>;
  isError: (result: T) => boolean;
  log: (event: EvtEvent) => void;
  failed: (phase: string, eventId: string) => void;
}

/** Persist an intent BEFORE side effects. Outcome failure must never pretend an action was undone. */
export async function auditedCall<T>(o: AuditedCallOptions<T>): Promise<T> {
  const invocationId = randomUUID();
  const event = (phase: string, outcome: string) =>
    identifyAudit({
      ...o.event,
      eventId: undefined,
      timestamp: new Date().toISOString(),
      payload: { ...o.event.payload, invocationId, phase, outcome },
    });
  const record = async (e: EvtEvent) => {
    o.log(e);
    try {
      await o.publish(e);
      return true;
    } catch {
      o.failed(String(e.payload.phase), e.eventId!);
      return false;
    }
  };
  if (o.sensitive && !(await record(event('intent', 'requested'))))
    throw new Error('Audit durable unavailable: action not executed. Please retry later.');
  let result: T;
  try {
    result = await o.run();
  } catch (error) {
    await record(event('outcome', 'exception'));
    throw error;
  }
  await record(event('outcome', o.isError(result) ? 'error' : 'success'));
  return result;
}
