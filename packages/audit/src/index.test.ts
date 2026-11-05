import { describe, it, expect, vi } from 'vitest';
import { auditedCall, type AuditedCallOptions } from './index.js';
import type { EvtEvent } from '@gs-backoffice/core';
const event: EvtEvent = {
  eventType: 'backoffice.audit.tool_invoked',
  source: { application: 'test', version: '1', environment: 'staging' },
  actor: { userId: 'u', accountId: 'a' },
  scope: { accountId: 'a', resourceType: 'tool', resourceId: 't' },
  payload: { tool: 't', runId: 'r' },
};
function setup(): AuditedCallOptions<{ isError: boolean }> {
  return {
    event,
    sensitive: true,
    publish: vi.fn().mockResolvedValue(undefined),
    run: vi.fn().mockResolvedValue({ isError: false }),
    isError: (r) => r.isError,
    log: vi.fn(),
    failed: vi.fn(),
  };
}
describe('durable audit boundary', () => {
  it('blocks side effects when intent cannot be deposited', async () => {
    const o = setup();
    o.publish = vi.fn().mockRejectedValue(new Error('down'));
    await expect(auditedCall(o)).rejects.toThrow('action not executed');
    expect(o.run).not.toHaveBeenCalled();
    expect(o.failed).toHaveBeenCalledWith('intent', expect.any(String));
  });
  it('waits for durable intent, correlates outcome, and uses different event IDs', async () => {
    const o = setup();
    const order: string[] = [];
    const events: EvtEvent[] = [];
    o.publish = async (e) => {
      order.push(String(e.payload.phase));
      events.push(e);
    };
    o.run = async () => {
      order.push('execute');
      return { isError: false };
    };
    await auditedCall(o);
    expect(order).toEqual(['intent', 'execute', 'outcome']);
    expect(events[0].payload.invocationId).toBe(events[1].payload.invocationId);
    expect(events[0].eventId).not.toBe(events[1].eventId);
  });
  it('records exceptions without replacing the original error', async () => {
    const o = setup();
    const error = new Error('original');
    o.run = vi.fn().mockRejectedValue(error);
    await expect(auditedCall(o)).rejects.toBe(error);
    expect(o.publish).toHaveBeenLastCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ outcome: 'exception' }) }),
    );
  });
  it('preserves successful side effects when outcome deposition fails', async () => {
    const o = setup();
    o.publish = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('down'));
    await expect(auditedCall(o)).resolves.toEqual({ isError: false });
    expect(o.run).toHaveBeenCalledTimes(1);
    expect(o.failed).toHaveBeenCalledWith('outcome', expect.any(String));
  });
  it('permits read-only work during an audit outage and reports degradation', async () => {
    const o = setup();
    o.sensitive = false;
    o.publish = vi.fn().mockRejectedValue(new Error('down'));
    await expect(auditedCall(o)).resolves.toEqual({ isError: false });
    expect(o.failed).toHaveBeenCalledTimes(1);
  });
});
