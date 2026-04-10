import express, { type Express } from 'express';
import pino from 'pino';

const logger = pino({ name: 'mcp-server' });
const app: Express = express();

app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'gs-backoffice-mcp' });
});

// Placeholder MCP tool endpoints — to be implemented in Phase 2
const MCP_TOOLS = [
  'backoffice_ask',
  'backoffice_start_workflow',
  'backoffice_ticket_update',
  'backoffice_ticket_status',
  'backoffice_data_query',
  'backoffice_digest',
] as const;

app.get('/tools', (_req, res) => {
  res.json({
    tools: MCP_TOOLS.map((name) => ({
      name,
      description: `[Placeholder] ${name}`,
      status: 'not_implemented',
    })),
  });
});

const PORT = parseInt(process.env.MCP_SERVER_PORT ?? '3001', 10);

app.listen(PORT, () => {
  logger.info({ port: PORT }, 'MCP server started');
});

export { app };
