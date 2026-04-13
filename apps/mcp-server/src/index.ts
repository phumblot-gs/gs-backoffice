import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import express, { type Express, type Request, type Response } from 'express';
import cors from 'cors';
import pino from 'pino';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { RBACConfigSchema } from '@gs-backoffice/core';
import { EvtClient } from '@gs-backoffice/evt-client';
import { JumpCloudClient } from '@gs-backoffice/jumpcloud-client';
import { createHenriMcpServer } from './server.js';
import { PluginManager } from './plugins/manager.js';
import { NotionPlugin } from './plugins/notion/index.js';
import { PaperclipPlugin } from './plugins/paperclip/index.js';
import { RBACResolver } from './auth/rbac.js';
import {
  createHenriAuth,
  getUserEmailFromToken,
  toNodeHandler,
  oAuthDiscoveryMetadata,
  oAuthProtectedResourceMetadata,
} from './auth/oauth.js';
import { signInPageHTML } from './auth/sign-in.js';

const logger = pino({ name: 'henri' });

// --- Configuration ---
const PORT = parseInt(process.env.MCP_SERVER_PORT ?? '3001', 10);
const NODE_ENV = process.env.NODE_ENV ?? 'development';
const BASE_URL =
  process.env.HENRI_PUBLIC_URL ??
  (NODE_ENV === 'production'
    ? 'https://mcp-backoffice.grand-shooting.com'
    : NODE_ENV === 'staging'
      ? 'https://mcp-backoffice-staging.grand-shooting.com'
      : `http://localhost:${PORT}`);

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? '';
const ALLOWED_DOMAIN = process.env.ALLOWED_EMAIL_DOMAIN ?? 'grand-shooting.com';

// --- OAuth enabled? ---
const oauthEnabled = Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);

// --- Load RBAC config ---
function loadRBACConfig() {
  try {
    const configPath = resolve(process.cwd(), 'config', 'rbac.json');
    const raw = readFileSync(configPath, 'utf-8');
    return RBACConfigSchema.parse(JSON.parse(raw));
  } catch {
    logger.warn('Could not load config/rbac.json — using empty RBAC config');
    return { groups: {} };
  }
}

const rbacConfig = loadRBACConfig();

// --- Initialize OAuth (if credentials are set) ---
const auth = oauthEnabled
  ? createHenriAuth({
      baseURL: BASE_URL,
      mcpResourceURL: `${BASE_URL}/mcp`,
      googleClientId: GOOGLE_CLIENT_ID,
      googleClientSecret: GOOGLE_CLIENT_SECRET,
      allowedDomain: ALLOWED_DOMAIN,
    })
  : null;

// --- Initialize EVT client ---
const evtClient =
  process.env.EVT_API_KEY && process.env.EVT_API_URL
    ? new EvtClient({
        apiKey: process.env.EVT_API_KEY,
        baseUrl: process.env.EVT_API_URL,
      })
    : null;

// --- Initialize JumpCloud client ---
const jumpcloud =
  process.env.JUMPCLOUD_API_KEY && process.env.JUMPCLOUD_ORG_ID
    ? new JumpCloudClient({
        apiKey: process.env.JUMPCLOUD_API_KEY,
        orgId: process.env.JUMPCLOUD_ORG_ID,
      })
    : null;

const rbacResolver = new RBACResolver(jumpcloud, rbacConfig);

// --- Initialize Plugin Manager ---
const pluginManager = new PluginManager({ evtClient, environment: NODE_ENV });

async function initializePlugins() {
  const credentials: Record<string, string> = {};
  for (const key of [
    'NOTION_API_TOKEN',
    'PAPERCLIP_API_URL',
    'PAPERCLIP_API_KEY',
    'PAPERCLIP_COMPANY_ID',
    'CHIEF_OF_STAFF_AGENT_ID',
  ]) {
    if (process.env[key]) credentials[key] = process.env[key];
  }

  const pluginConfig = { credentials, evtClient, logger };
  await pluginManager.register(new NotionPlugin(), pluginConfig);
  await pluginManager.register(new PaperclipPlugin(), pluginConfig);

  logger.info(
    { plugins: pluginManager.getAllTools().map((t) => t.name) },
    'All plugins initialized',
  );
}

// --- Session management ---
const transports: Record<string, StreamableHTTPServerTransport> = {};

// --- Express app ---
const app: Express = express();
app.use(cors({ origin: true, credentials: true }));

// --- OAuth routes (mounted BEFORE body parsers for Better Auth) ---
if (auth) {
  app.all('/api/auth/{*splat}', toNodeHandler(auth));
  app.options('/.well-known/oauth-authorization-server', cors());
  app.get(
    '/.well-known/oauth-authorization-server',
    cors(),
    toNodeHandler(oAuthDiscoveryMetadata(auth)),
  );
  app.options('/.well-known/oauth-protected-resource/mcp', cors());
  app.get(
    '/.well-known/oauth-protected-resource/mcp',
    cors(),
    toNodeHandler(oAuthProtectedResourceMetadata(auth)),
  );
  app.get('/auth/sign-in', (_req, res) => {
    res.type('html').send(signInPageHTML(BASE_URL));
  });
  app.get('/auth/callback', (_req, res) => {
    res
      .type('html')
      .send(
        '<html><body><script>window.close()</script>Authentication successful. You can close this window.</body></html>',
      );
  });
  logger.info({ baseURL: BASE_URL }, 'OAuth enabled with Google');
} else {
  logger.warn('OAuth disabled — GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET not set. Using dev mode.');
}

app.use(express.json());

// --- Health check ---
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'henri',
    oauth: oauthEnabled ? 'enabled' : 'disabled',
    plugins: pluginManager.getAllTools().map((t) => t.name),
    paperclipUrl: process.env.PAPERCLIP_API_URL,
  });
});

// --- Resolve user from request ---
async function resolveUserContext(req: Request) {
  if (auth) {
    const authHeader = req.headers.authorization;
    const user = await getUserEmailFromToken(auth, authHeader);
    if (user) {
      // Verify domain restriction
      if (!user.email.endsWith(`@${ALLOWED_DOMAIN}`)) {
        return null;
      }
      return rbacResolver.resolve(user.userId, user.email);
    }
    return null;
  }
  // Dev mode — no OAuth
  return rbacResolver.resolve('dev-user', 'dev@grand-shooting.com');
}

// --- MCP endpoints ---
app.post('/mcp', async (req: Request, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  try {
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports[sessionId]) {
      transport = transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      // Resolve authenticated user
      const userContext = await resolveUserContext(req);
      if (oauthEnabled && !userContext) {
        const metadataUrl = `${BASE_URL}/.well-known/oauth-protected-resource/mcp`;
        res
          .status(401)
          .set('WWW-Authenticate', `Bearer resource_metadata="${metadataUrl}"`)
          .json({
            jsonrpc: '2.0',
            error: { code: -32001, message: 'Authentication required' },
            id: null,
          });
        return;
      }

      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          logger.info({ sessionId: sid, user: userContext?.userEmail }, 'MCP session initialized');
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

      const server = createHenriMcpServer(
        pluginManager,
        userContext ?? {
          userId: 'dev-user',
          userEmail: 'dev@grand-shooting.com',
          groups: ['*'],
          permissions: ['*'],
        },
      );
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

app.get('/mcp', async (req: Request, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send('Missing or invalid session ID');
    return;
  }
  await transports[sessionId].handleRequest(req, res);
});

app.delete('/mcp', async (req: Request, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send('Missing or invalid session ID');
    return;
  }
  await transports[sessionId].handleRequest(req, res);
});

// --- Start ---
initializePlugins()
  .then(() => {
    app.listen(PORT, () => {
      logger.info(
        { port: PORT, environment: NODE_ENV, oauth: oauthEnabled, baseURL: BASE_URL },
        'Henri MCP server started',
      );
    });
  })
  .catch((err) => {
    logger.fatal({ error: err }, 'Failed to initialize plugins');
    process.exit(1);
  });

export { app };
