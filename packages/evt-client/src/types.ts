import type { EvtEvent } from '@gs-backoffice/core';

export interface EvtClientConfig {
  baseUrl: string;
  apiKey: string;
}

export interface EvtMessage {
  id: string;
  receiptHandle: string;
  event: EvtEvent;
  receivedAt: string;
}
