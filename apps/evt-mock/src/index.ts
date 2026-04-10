import express, { type Express } from 'express';
import pino from 'pino';

const logger = pino({ name: 'evt-mock' });
const app: Express = express();

app.use(express.json());

interface StoredEvent {
  eventId: string;
  eventType: string;
  timestamp: string;
  source: { application: string; version: string; environment: string };
  actor: { userId: string; accountId: string; role?: string };
  scope: { accountId: string; resourceType: string; resourceId: string };
  payload: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

const events: StoredEvent[] = [];

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'evt-mock', eventCount: events.length });
});

// Publish an event — POST /v1/events
app.post('/v1/events', (req, res) => {
  const body = req.body as Partial<StoredEvent>;
  const eventId =
    body.eventId ?? `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const event: StoredEvent = {
    eventId,
    eventType: body.eventType ?? 'unknown',
    timestamp: (body.timestamp as string) ?? new Date().toISOString(),
    source: body.source ?? { application: 'unknown', version: '0.0.0', environment: 'development' },
    actor: body.actor ?? { userId: 'unknown', accountId: 'unknown' },
    scope: body.scope ?? { accountId: 'unknown', resourceType: 'unknown', resourceId: 'unknown' },
    payload: body.payload ?? {},
    metadata: body.metadata,
  };
  events.push(event);
  logger.info({ eventId, eventType: event.eventType }, 'Event published');
  res.status(201).json({ eventId });
});

// Query events — POST /v1/events/query
app.post('/v1/events/query', (req, res) => {
  const body = req.body as {
    filters?: { eventTypes?: string[]; applications?: string[]; accountIds?: string[] };
    timeRange?: { from?: string; to?: string };
    limit?: number;
    cursor?: string;
  };

  const limit = body.limit ?? 100;
  let filtered = [...events];

  // Apply filters
  if (body.filters?.eventTypes?.length) {
    filtered = filtered.filter((e) => body.filters!.eventTypes!.includes(e.eventType));
  }
  if (body.filters?.applications?.length) {
    filtered = filtered.filter((e) => body.filters!.applications!.includes(e.source.application));
  }
  if (body.filters?.accountIds?.length) {
    filtered = filtered.filter((e) => body.filters!.accountIds!.includes(e.scope.accountId));
  }

  // Apply time range
  if (body.timeRange?.from) {
    const from = new Date(body.timeRange.from).getTime();
    filtered = filtered.filter((e) => new Date(e.timestamp).getTime() >= from);
  }
  if (body.timeRange?.to) {
    const to = new Date(body.timeRange.to).getTime();
    filtered = filtered.filter((e) => new Date(e.timestamp).getTime() <= to);
  }

  // Apply cursor (skip events before cursor)
  if (body.cursor) {
    const cursorIndex = filtered.findIndex((e) => e.eventId === body.cursor);
    if (cursorIndex >= 0) {
      filtered = filtered.slice(cursorIndex + 1);
    }
  }

  // Sort newest first and apply limit
  filtered.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  const page = filtered.slice(0, limit);
  const hasMore = filtered.length > limit;

  res.json({
    events: page,
    limit,
    total: filtered.length,
    cursor: page.length > 0 ? page[0].eventId : undefined,
    hasMore,
  });
});

const PORT = parseInt(process.env.EVT_MOCK_PORT ?? '4000', 10);

app.listen(PORT, () => {
  logger.info({ port: PORT }, 'EVT mock server started');
});

export { app };
