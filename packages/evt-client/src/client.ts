import type { EvtEvent } from '@gs-backoffice/core';
import type { EvtClientConfig, EvtMessage } from './types.js';

export class EvtClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(config: EvtClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey;
  }

  async publish(event: EvtEvent): Promise<{ eventId: string }> {
    const res = await fetch(`${this.baseUrl}/v1/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(event),
    });
    if (!res.ok) {
      throw new Error(`EVT publish failed: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as { eventId: string };
  }

  async consume(queueName: string, maxMessages = 10): Promise<EvtMessage[]> {
    const params = new URLSearchParams({ maxMessages: String(maxMessages) });
    const res = await fetch(`${this.baseUrl}/v1/queues/${queueName}/messages?${params}`, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
    });
    if (!res.ok) {
      throw new Error(`EVT consume failed: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as EvtMessage[];
  }

  async acknowledge(queueName: string, receiptHandle: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/v1/queues/${queueName}/messages`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ receiptHandle }),
    });
    if (!res.ok) {
      throw new Error(`EVT acknowledge failed: ${res.status} ${res.statusText}`);
    }
  }
}
