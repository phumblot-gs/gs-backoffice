import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EvtClient } from './client.js';
import { EvtApiError } from './errors.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
    headers: new Headers(),
  } as Response;
}

describe('EvtClient', () => {
  let client: EvtClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new EvtClient({
      apiKey: 'test-key',
      baseUrl: 'http://localhost:4000',
      retries: 0,
      timeout: 5000,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('publish', () => {
    it('publishes an event and returns eventId', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ eventId: 'evt-123' }));

      const result = await client.publish({
        eventType: 'backoffice.invoice.draft_created',
        source: { application: 'gs-backoffice', version: '0.1.0', environment: 'development' },
        actor: { userId: 'agent-1', accountId: 'grafmaker' },
        scope: { accountId: 'grafmaker', resourceType: 'invoice', resourceId: 'inv-1' },
        payload: { amount: 500 },
      });

      expect(result.eventId).toBe('evt-123');
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:4000/v1/events',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('includes authorization header', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ eventId: 'evt-123' }));

      await client.publish({
        eventType: 'test',
        source: { application: 'test', version: '1.0', environment: 'development' },
        actor: { userId: 'u', accountId: 'a' },
        scope: { accountId: 'a', resourceType: 'r', resourceId: 'r1' },
        payload: {},
      });

      const callHeaders = mockFetch.mock.calls[0][1].headers;
      expect(callHeaders.Authorization).toBe('Bearer test-key');
    });

    it('throws EvtApiError on failure', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ error: 'unauthorized' }, 401));

      await expect(
        client.publish({
          eventType: 'test',
          source: { application: 'test', version: '1.0', environment: 'development' },
          actor: { userId: 'u', accountId: 'a' },
          scope: { accountId: 'a', resourceType: 'r', resourceId: 'r1' },
          payload: {},
        }),
      ).rejects.toThrow(EvtApiError);
    });
  });

  describe('query', () => {
    it('queries events with filters', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          events: [
            {
              eventId: 'evt-1',
              eventType: 'backoffice.digest.published',
              source: { application: 'gs-backoffice', version: '0.1.0', environment: 'staging' },
              actor: { userId: 'agent-cos', accountId: 'grafmaker' },
              scope: { accountId: 'grafmaker', resourceType: 'digest', resourceId: 'd-1' },
              payload: {},
            },
          ],
          limit: 100,
          hasMore: false,
        }),
      );

      const result = await client.query({
        filters: { eventTypes: ['backoffice.digest.published'] },
        limit: 10,
      });

      expect(result.events).toHaveLength(1);
      expect(result.events[0].eventType).toBe('backoffice.digest.published');
    });

    it('sends cursor for pagination', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ events: [], limit: 100, hasMore: false }),
      );

      await client.query({ cursor: 'evt-prev-100' });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.cursor).toBe('evt-prev-100');
    });
  });
});
