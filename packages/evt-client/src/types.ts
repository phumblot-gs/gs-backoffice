import type { EvtEvent, EvtQueryParams, EvtQueryResult } from '@gs-backoffice/core';

export interface EvtClientConfig {
  apiKey: string;
  baseUrl?: string;
  timeout?: number;
  retries?: number;
}

/** Spec to create a server-side-filtered durable queue. */
export interface EvtQueueSpec {
  name: string;
  filters?: { eventTypes?: string[] };
  config?: {
    maxMessages?: number;
    waitTimeSeconds?: number;
    visibilityTimeout?: number;
    retentionPeriod?: number;
  };
}

/** A queue as returned by the EVT API. */
export interface EvtQueue {
  id: string;
  name: string;
  status: string;
  filters?: { eventTypes?: string[] };
  config?: Record<string, number>;
  /** Messages endpoint (a distinct host from the API base). */
  endpoints?: { messages: string };
  stats?: Record<string, number>;
}

/** A received queue message; `body` is the full EVT event. */
export interface EvtQueueMessage {
  messageId: string;
  receiptHandle: string;
  body: EvtEvent;
  attributes?: Record<string, unknown>;
}

export type { EvtEvent, EvtQueryParams, EvtQueryResult };
