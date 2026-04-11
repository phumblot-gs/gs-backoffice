import type { EvtEvent, EvtQueryParams, EvtQueryResult } from '@gs-backoffice/core';
import type { EvtClientConfig } from './types.js';
import { EvtApiError } from './errors.js';

const DEFAULT_BASE_URL = 'https://api.events.grand-shooting.com';
const DEFAULT_TIMEOUT = 30000;
const DEFAULT_RETRIES = 3;

export class EvtClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeout: number;
  private readonly retries: number;

  constructor(config: EvtClientConfig) {
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT;
    this.retries = config.retries ?? DEFAULT_RETRIES;
  }

  async publish(event: Partial<EvtEvent>): Promise<{ eventId: string }> {
    return this.request<{ eventId: string }>('/v1/events', {
      method: 'POST',
      body: JSON.stringify(event),
    });
  }

  async query(params: EvtQueryParams): Promise<EvtQueryResult> {
    const apiParams: Record<string, unknown> = {
      limit: params.limit ?? 100,
    };
    if (params.filters) {
      apiParams.filters = params.filters;
    }
    if (params.timeRange) {
      apiParams.timeRange = params.timeRange;
    }
    if (params.cursor) {
      apiParams.cursor = params.cursor;
    }
    return this.request<EvtQueryResult>('/v1/events/query', {
      method: 'POST',
      body: JSON.stringify(apiParams),
    });
  }

  async *poll(options: {
    filters?: EvtQueryParams['filters'];
    interval?: number;
    signal?: AbortSignal;
  }): AsyncGenerator<EvtEvent, void, unknown> {
    const interval = Math.max(500, Math.min(30000, options.interval ?? 2000));
    let cursor: string | undefined;
    let isFirstPoll = true;

    while (!options.signal?.aborted) {
      try {
        const result = await this.query({
          limit: 100,
          filters: options.filters,
          cursor,
        });

        if (result.events.length > 0) {
          cursor = result.cursor ?? result.events[0].eventId;

          if (!isFirstPoll) {
            const events = [...result.events].reverse();
            for (const event of events) {
              yield event;
            }
          }
        }

        isFirstPoll = false;
      } catch (error) {
        if (error instanceof EvtApiError && (error.status === 401 || error.status === 403)) {
          throw error;
        }
        // Swallow other errors and continue polling
      }

      await new Promise<void>((resolve) => {
        const timeoutId = setTimeout(resolve, interval);
        options.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timeoutId);
            resolve();
          },
          { once: true },
        );
      });
    }
  }

  private async request<T>(path: string, options: RequestInit): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);

        const response = await fetch(url, {
          ...options,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
            ...options.headers,
          },
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          const errorText = await response.text();
          throw new EvtApiError(response.status, path, errorText);
        }

        return (await response.json()) as T;
      } catch (error) {
        lastError = error as Error;

        if (error instanceof Error && error.name === 'AbortError') {
          throw new EvtApiError(0, path, `Request timeout after ${this.timeout}ms`);
        }

        // Don't retry auth errors
        if (error instanceof EvtApiError && (error.status === 401 || error.status === 403)) {
          throw error;
        }

        if (attempt < this.retries) {
          const delay = Math.pow(2, attempt) * 1000;
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        throw error;
      }
    }

    throw lastError ?? new Error('Request failed');
  }
}
