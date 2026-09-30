import { EvtEventSchema, type EvtEvent } from '@gs-backoffice/core';
export interface Message {
  Body?: string;
  ReceiptHandle?: string;
  MessageId?: string;
}
export interface Dependencies {
  receive: () => Promise<Message[]>;
  deliver: (event: EvtEvent) => Promise<unknown>;
  remove: (receipt: string) => Promise<unknown>;
  defer: (receipt: string, seconds: number) => Promise<unknown>;
  quarantine: (body: string) => Promise<unknown>;
  sleep: (ms: number) => Promise<void>;
  log: (signal: string, fields?: Record<string, unknown>) => void;
  random?: () => number;
}

/** Single in-flight request; no receive while the downstream circuit is open. */
export class AuditWorker {
  private failures = 0;
  constructor(private d: Dependencies) {}
  async tick(): Promise<void> {
    const messages = await this.d.receive();
    for (const message of messages) {
      const receipt = message.ReceiptHandle;
      if (!receipt) continue;
      let event: EvtEvent;
      try {
        event = EvtEventSchema.parse(JSON.parse(message.Body || ''));
        if (!event.eventId || !event.eventType.startsWith('backoffice.'))
          throw new Error('Invalid audit envelope');
      } catch {
        await this.d.quarantine(message.Body || '{}');
        await this.d.remove(receipt);
        this.d.log('AUDIT_QUARANTINED', { reason: 'invalid_envelope' });
        continue;
      }
      try {
        await this.d.deliver(event);
      } catch (error) {
        const status = Number((error as { status?: number }).status || 0);
        // Auth failures and throttling indicate an unavailable service, never a poison event.
        if ([400, 413, 422].includes(status)) {
          await this.d.quarantine(message.Body!);
          await this.d.remove(receipt);
          this.d.log('AUDIT_QUARANTINED', { eventId: event.eventId, status });
          await this.d.sleep(1000);
          continue;
        }
        this.failures++;
        const base = Math.min(900, 30 * 2 ** Math.min(this.failures - 1, 5));
        const seconds = Math.min(
          900,
          Math.ceil(base * (1 + (this.d.random ?? Math.random)() * 0.2)),
        );
        this.d.log('AUDIT_CIRCUIT_OPEN', { status, seconds, eventId: event.eventId });
        // Defer this message, then stop consuming altogether during the outage.
        try {
          await this.d.defer(receipt, seconds);
        } finally {
          await this.d.sleep(seconds * 1000);
        }
        return;
      }
      // Delete ONLY after EVT acknowledged it. A lost ack retries the same eventId.
      await this.d.remove(receipt);
      if (this.failures) this.d.log('AUDIT_CIRCUIT_RECOVERED');
      this.failures = 0;
      this.d.log('AUDIT_DELIVERED', { eventId: event.eventId });
      await this.d.sleep(1000); // At most one EVT publish per second, including recovery.
    }
  }
}
