import { describe, it, expect, vi, beforeEach } from 'vitest';
const mocks = vi.hoisted(() => ({ s3: vi.fn(), sqs: vi.fn() }));
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    send = mocks.s3;
  },
  PutObjectCommand: class {
    constructor(public input: unknown) {}
  },
}));
vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: class {
    send = mocks.sqs;
  },
  SendMessageCommand: class {
    constructor(public input: unknown) {}
  },
}));
import { createAuditPublisher } from './index.js';
const env = { AUDIT_QUEUE_URL: 'queue', AUDIT_ARCHIVE_BUCKET: 'bucket' };
const event = {
  eventId: 'stable-id',
  eventType: 'backoffice.audit.tool_invoked',
  source: { application: 'test', version: '1', environment: 'staging' as const },
  actor: { userId: 'u', accountId: 'a' },
  scope: { accountId: 'a', resourceType: 'tool', resourceId: 't' },
  payload: {},
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.s3.mockResolvedValue({});
  mocks.sqs.mockResolvedValue({});
});
describe('archive then queue', () => {
  it('archives identical payload before enqueuing with the stable event ID', async () => {
    await createAuditPublisher(env)(event);
    const archived = mocks.s3.mock.calls[0][0].input;
    expect(archived.Key).toBe('audit/stable-id.json');
    expect(archived.Body).toBe(mocks.sqs.mock.calls[0][0].input.MessageBody);
    expect(mocks.s3.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.sqs.mock.invocationCallOrder[0],
    );
  });
  it('does not enqueue if archival failed', async () => {
    mocks.s3.mockRejectedValue(new Error('storage down'));
    await expect(createAuditPublisher(env)(event)).rejects.toThrow('storage down');
    expect(mocks.sqs).not.toHaveBeenCalled();
  });
  it('retains the S3 evidence if enqueue fails, and rejects the intent gate', async () => {
    mocks.sqs.mockRejectedValue(new Error('queue down'));
    await expect(createAuditPublisher(env)(event)).rejects.toThrow('queue down');
    expect(mocks.s3).toHaveBeenCalledTimes(1);
  });
  it('rejects missing configuration and oversized payloads before network I/O', async () => {
    await expect(createAuditPublisher({})(event)).rejects.toThrow('not configured');
    await expect(
      createAuditPublisher(env)({ ...event, payload: { huge: 'x'.repeat(65536) } }),
    ).rejects.toThrow('64 KiB');
    expect(mocks.s3).not.toHaveBeenCalled();
  });
  it('bounds a stalled credential/write promise to the deposit deadline', async () => {
    mocks.s3.mockImplementation(() => new Promise(() => {}));
    const start = Date.now();
    await expect(createAuditPublisher(env)(event)).rejects.toThrow('deadline');
    expect(Date.now() - start).toBeLessThan(4000);
    expect(mocks.sqs).not.toHaveBeenCalled();
  }, 5000);
});
