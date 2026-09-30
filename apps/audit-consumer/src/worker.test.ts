import { describe, it, expect, vi } from 'vitest';
import { AuditWorker, type Dependencies } from './worker.js';
const event = {
  eventId: 'stable-id',
  eventType: 'backoffice.audit.tool_invoked',
  source: { application: 'test', version: '1', environment: 'staging' },
  actor: { userId: 'u', accountId: 'a' },
  scope: { accountId: 'a', resourceType: 'tool', resourceId: 't' },
  payload: {},
};
const message = { Body: JSON.stringify(event), ReceiptHandle: 'r' };
function deps(): Dependencies {
  return {
    receive: vi.fn().mockResolvedValue([message]),
    deliver: vi.fn().mockResolvedValue({}),
    remove: vi.fn().mockResolvedValue({}),
    defer: vi.fn().mockResolvedValue({}),
    quarantine: vi.fn().mockResolvedValue({}),
    sleep: vi.fn().mockResolvedValue(undefined),
    log: vi.fn(),
    random: () => 0,
  };
}
describe('bounded delivery', () => {
  it('acks only successful delivery and limits throughput even during recovery', async () => {
    const d = deps();
    await new AuditWorker(d).tick();
    expect(d.deliver).toHaveBeenCalledWith(event);
    expect(d.remove).toHaveBeenCalledWith('r');
    expect(d.sleep).toHaveBeenCalledWith(1000);
  });
  it('stops consuming while the circuit is open; no DLQ exhaustion during an outage', async () => {
    const d = deps();
    d.deliver = vi.fn().mockRejectedValue({ status: 503 });
    let resume!: () => void;
    d.sleep = vi.fn().mockImplementation(
      () =>
        new Promise<void>((r) => {
          resume = r;
        }),
    );
    const w = new AuditWorker(d);
    const pending = w.tick();
    await vi.waitFor(() => expect(d.sleep).toHaveBeenCalledWith(30000));
    expect(d.receive).toHaveBeenCalledTimes(1);
    expect(d.remove).not.toHaveBeenCalled();
    expect(d.quarantine).not.toHaveBeenCalled();
    resume();
    await pending;
  });
  it.each([401, 403, 429, 500, 0])(
    'treats status %s as outage, not a poison event',
    async (status) => {
      const d = deps();
      d.deliver = vi.fn().mockRejectedValue({ status });
      const w = new AuditWorker(d);
      for (let i = 0; i < 10; i++) await w.tick();
      expect(d.quarantine).not.toHaveBeenCalled();
      expect(d.remove).not.toHaveBeenCalled();
      expect(d.sleep).toHaveBeenLastCalledWith(900000);
    },
  );
  it.each([400, 413, 422])('quarantines a permanently rejected event (%s)', async (status) => {
    const d = deps();
    d.deliver = vi.fn().mockRejectedValue({ status });
    await new AuditWorker(d).tick();
    expect(d.quarantine).toHaveBeenCalledWith(message.Body);
    expect(d.remove).toHaveBeenCalledWith('r');
  });
  it('never deletes a malformed message unless DLQ accepted it', async () => {
    const d = deps();
    d.receive = vi.fn().mockResolvedValue([{ ...message, Body: 'not-json' }]);
    d.quarantine = vi.fn().mockRejectedValue(new Error('down'));
    await expect(new AuditWorker(d).tick()).rejects.toThrow('down');
    expect(d.remove).not.toHaveBeenCalled();
    expect(d.deliver).not.toHaveBeenCalled();
  });
  it('retries the same event ID when delivery succeeded but acknowledgement failed', async () => {
    const d = deps();
    d.remove = vi.fn().mockRejectedValueOnce(new Error('ack lost')).mockResolvedValue({});
    const w = new AuditWorker(d);
    await expect(w.tick()).rejects.toThrow('ack lost');
    await w.tick();
    expect(d.deliver).toHaveBeenNthCalledWith(1, event);
    expect(d.deliver).toHaveBeenNthCalledWith(2, event);
  });
});
