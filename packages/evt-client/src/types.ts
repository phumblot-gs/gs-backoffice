import type { EvtEvent, EvtQueryParams, EvtQueryResult } from '@gs-backoffice/core';

export interface EvtClientConfig {
  apiKey: string;
  baseUrl?: string;
  timeout?: number;
  retries?: number;
}

export type { EvtEvent, EvtQueryParams, EvtQueryResult };
