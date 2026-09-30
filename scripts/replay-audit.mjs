#!/usr/bin/env node
// Explicit, single-event recovery. Never scan/replay the whole archive automatically.
import { createRequire } from 'node:module';
import { EvtEventSchema } from '../packages/core/dist/index.js';
const require = createRequire(new URL('../packages/audit/package.json', import.meta.url));
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const id = args.find((arg) => !arg.startsWith('--'));
if (
  !id ||
  !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ||
  args.some((arg) => arg !== id && arg !== '--apply')
) {
  console.error('Usage: node scripts/replay-audit.mjs <event-uuid> [--apply]');
  process.exit(1);
}
const bucket = process.env.AUDIT_ARCHIVE_BUCKET;
const queue = process.env.AUDIT_QUEUE_URL;
const environment = process.env.AUDIT_ENVIRONMENT;
if (
  !['staging', 'production'].includes(environment) ||
  !bucket?.startsWith(`gs-backoffice-${environment}-run-logs-`) ||
  !queue?.endsWith(`/gs-backoffice-${environment}-audit`)
)
  throw new Error('Set matching AUDIT_ENVIRONMENT, AUDIT_ARCHIVE_BUCKET and AUDIT_QUEUE_URL');
const options = { region: process.env.AWS_REGION || 'eu-west-1', maxAttempts: 1 };
const s3 = new S3Client(options);
const sqs = new SQSClient(options);
try {
  const response = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: `audit/${id}.json` }),
    { abortSignal: AbortSignal.timeout(10000) },
  );
  if ((response.ContentLength ?? Infinity) > 65536) throw new Error('Invalid archive size');
  const body = await response.Body.transformToString();
  const event = EvtEventSchema.parse(JSON.parse(body));
  if (
    event.eventId !== id ||
    event.source.environment !== environment ||
    !event.eventType.startsWith('backoffice.')
  )
    throw new Error('Invalid archive envelope');
  console.log(
    JSON.stringify({
      eventId: id,
      eventType: event.eventType,
      environment: event.source.environment,
      phase: event.payload.phase,
      mode: apply ? 'apply' : 'dry-run',
    }),
  );
  // Identical ID and original timestamp. This sends an audit fact, NEVER reruns a tool.
  if (apply) {
    await sqs.send(new SendMessageCommand({ QueueUrl: queue, MessageBody: body }), {
      abortSignal: AbortSignal.timeout(10000),
    });
    console.log('Enqueued for bounded delivery by audit-consumer.');
  } else console.log('Nothing enqueued. Check environment and EVT receipt before using --apply.');
} catch {
  console.error(
    'Audit recovery failed; check credentials, permissions, environment and event ID. No payload printed.',
  );
  process.exitCode = 1;
} finally {
  s3.destroy();
  sqs.destroy();
}
