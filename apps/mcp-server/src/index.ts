import { randomUUID } from 'node:crypto';
import express, { type Express, type Request, type Response } from 'express';
import cors from 'cors';
import pino from 'pino';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createBackofficeMcpServer } from './server.js';
import { PaperclipClient } from './paperclip-client.js';
import { RBACResolver } from './auth/rbac.js';
import { JumpCloudClient } from '@gs-backoffice/jumpcloud-client';
import type { RBACConfig } from '@gs-backoffice/core';

const logger = pino({ name: 'mcp-server' });

// Configuration from environment
const PORT = parseInt(process.env.MCP_SERVER_PORT ?? '3001', 10);
const PAPERCLIP_API_URL = process.env.PAPERCLIP_API_URL ?? 'http://localhost:3100';
const PAPERCLIP_API_KEY = process.env.PAPERCLIP_API_KEY;
const PAPERCLIP_COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID ?? '';
const CHIEF_OF_STAFF_AGENT_ID = process.env.CHIEF_OF_STAFF_AGENT_ID ?? '';
const JUMPCLOUD_API_KEY = process.env.JUMPCLOUD_API_KEY;
const JUMPCLOUD_ORG_ID = process.env.JUMPCLOUD_ORG_ID;

// RBAC config — loaded from env or defaults to open access in dev
const rbacConfig: RBACConfig = { groups: {} };

// Initialize clients
const paperclip = new PaperclipClient({
  apiUrl: PAPERCLIP_API_URL,
  apiKey: PAPERCLIP_API_KEY,
});

const jumpcloud =
  JUMPCLOUD_API_KEY && JUMPCLOUD_ORG_ID
    ? new JumpCloudClient({ apiKey: JUMPCLOUD_API_KEY, orgId: JUMPCLOUD_ORG_ID })
    : null;

const rbacResolver = new RBACResolver(jumpcloud, rbacConfig);

// Session management
const transports: Record<string, StreamableHTTPServerTransport> = {};

// Express app
const app: Express = express();
app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'gs-backoffice-mcp', paperclipUrl: PAPERCLIP_API_URL });
});

// MCP endpoint — POST /mcp
app.post('/mcp', async (req: Request, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  try {
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports[sessionId]) {
      transport = transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          logger.info({ sessionId: sid }, 'MCP session initialized');
          transports[sid] = transport;
        },
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && transports[sid]) {
          logger.info({ sessionId: sid }, 'MCP session closed');
          delete transports[sid];
        }
      };

      const server = createBackofficeMcpServer({
        paperclip,
        rbacResolver,
        companyId: PAPERCLIP_COMPANY_ID,
        chiefOfStaffAgentId: CHIEF_OF_STAFF_AGENT_ID,
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    } else if (sessionId) {
      res.status(404).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Session not found' },
        id: null,
      });
      return;
    } else {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: Session ID required' },
        id: null,
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    logger.error({ error }, 'Error handling MCP request');
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
});

// MCP endpoint — GET /mcp (SSE stream)
app.get('/mcp', async (req: Request, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send('Missing or invalid session ID');
    return;
  }
  await transports[sessionId].handleRequest(req, res);
});

// MCP endpoint — DELETE /mcp (session termination)
app.delete('/mcp', async (req: Request, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send('Missing or invalid session ID');
    return;
  }
  await transports[sessionId].handleRequest(req, res);
});

app.listen(PORT, () => {
  logger.info({ port: PORT, paperclipUrl: PAPERCLIP_API_URL }, 'MCP server started');
});

export { app };
