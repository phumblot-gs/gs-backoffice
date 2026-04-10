import express, { type Express } from 'express';
import pino from 'pino';

const logger = pino({ name: 'evt-mock' });
const app: Express = express();

app.use(express.json());

interface StoredEvent {
  eventId: string;
  type: string;
  actor: string;
  scope?: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

const events: StoredEvent[] = [];
const queues: Map<string, StoredEvent[]> = new Map();

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'evt-mock', eventCount: events.length });
});

// Publish an event
app.post('/v1/events', (req, res) => {
  const { type, actor, scope, payload } = req.body as {
    type: string;
    actor: string;
    scope?: string;
    payload: Record<string, unknown>;
  };
  const eventId = `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const event: StoredEvent = {
    eventId,
    type,
    actor,
    scope,
    payload: payload ?? {},
    timestamp: new Date().toISOString(),
  };
  events.push(event);
  logger.info({ eventId, type, actor }, 'Event published');
  res.status(201).json({ eventId });
});

// Consume messages from a queue
app.get('/v1/queues/:name/messages', (req, res) => {
  const { name } = req.params;
  const queue = queues.get(name) ?? [];
  const maxMessages = parseInt((req.query.maxMessages as string) ?? '10', 10);
  const messages = queue.slice(0, maxMessages).map((event) => ({
    id: event.eventId,
    receiptHandle: `rh_${event.eventId}`,
    event,
    receivedAt: new Date().toISOString(),
  }));
  res.json(messages);
});

// Acknowledge messages
app.delete('/v1/queues/:name/messages', (req, res) => {
  const { name } = req.params;
  const { receiptHandle } = req.body as { receiptHandle: string };
  logger.info({ queue: name, receiptHandle }, 'Message acknowledged');
  res.status(204).send();
});

// Debug: list all events
app.get('/v1/events', (_req, res) => {
  res.json(events);
});

const PORT = parseInt(process.env.EVT_MOCK_PORT ?? '4000', 10);

app.listen(PORT, () => {
  logger.info({ port: PORT }, 'EVT mock server started');
});

export { app };
