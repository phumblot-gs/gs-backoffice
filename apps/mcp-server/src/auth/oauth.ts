import { betterAuth } from 'better-auth';
import { mcp } from 'better-auth/plugins';
import { oAuthDiscoveryMetadata, oAuthProtectedResourceMetadata } from 'better-auth/plugins';
import { toNodeHandler } from 'better-auth/node';
import { Pool } from 'pg';
import pino from 'pino';

const logger = pino({ name: 'oauth' });

export interface OAuthConfig {
  baseURL: string;
  mcpResourceURL: string;
  googleClientId: string;
  googleClientSecret: string;
  allowedDomain: string;
  databaseUrl?: string;
}

async function ensureAuthTables(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    // Use a separate schema to avoid conflicts with Paperclip tables
    await client.query(`CREATE SCHEMA IF NOT EXISTS henri_auth`);
    await client.query(`SET search_path TO henri_auth, public`);
    // All tables in henri_auth schema — avoids conflicts with Paperclip's own Better Auth tables
    const tables = [
      `CREATE TABLE IF NOT EXISTS henri_auth."user" (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
        "emailVerified" BOOLEAN NOT NULL DEFAULT false, image TEXT,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(), "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE IF NOT EXISTS henri_auth."session" (
        id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, "expiresAt" TIMESTAMPTZ NOT NULL,
        "ipAddress" TEXT, "userAgent" TEXT, "userId" TEXT NOT NULL REFERENCES henri_auth."user"(id),
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(), "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE IF NOT EXISTS henri_auth."account" (
        id TEXT PRIMARY KEY, "accountId" TEXT NOT NULL, "providerId" TEXT NOT NULL,
        "userId" TEXT NOT NULL REFERENCES henri_auth."user"(id),
        "accessToken" TEXT, "refreshToken" TEXT, "idToken" TEXT,
        "accessTokenExpiresAt" TIMESTAMPTZ, "refreshTokenExpiresAt" TIMESTAMPTZ,
        scope TEXT, password TEXT,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(), "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE IF NOT EXISTS henri_auth."verification" (
        id TEXT PRIMARY KEY, identifier TEXT NOT NULL, value TEXT NOT NULL,
        "expiresAt" TIMESTAMPTZ NOT NULL, "createdAt" TIMESTAMPTZ, "updatedAt" TIMESTAMPTZ
      )`,
      `CREATE TABLE IF NOT EXISTS henri_auth."oauthApplication" (
        id TEXT PRIMARY KEY, name TEXT, icon TEXT, metadata TEXT,
        "clientId" TEXT NOT NULL UNIQUE, "clientSecret" TEXT, "redirectUrls" TEXT NOT NULL,
        type TEXT NOT NULL, disabled BOOLEAN NOT NULL DEFAULT false, "userId" TEXT,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(), "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE IF NOT EXISTS henri_auth."oauthAccessToken" (
        id TEXT PRIMARY KEY, "accessToken" TEXT NOT NULL UNIQUE, "refreshToken" TEXT UNIQUE,
        "accessTokenExpiresAt" TIMESTAMPTZ NOT NULL, "refreshTokenExpiresAt" TIMESTAMPTZ,
        "clientId" TEXT NOT NULL, "userId" TEXT, scopes TEXT NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(), "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE IF NOT EXISTS henri_auth."oauthRefreshToken" (
        id TEXT PRIMARY KEY, "refreshToken" TEXT NOT NULL UNIQUE, "accessTokenId" TEXT NOT NULL,
        "expiresAt" TIMESTAMPTZ NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(), "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE IF NOT EXISTS henri_auth."oauthAuthorizationCode" (
        id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, "clientId" TEXT NOT NULL, "userId" TEXT,
        scopes TEXT NOT NULL, "redirectURI" TEXT NOT NULL,
        "codeChallenge" TEXT, "codeChallengeMethod" TEXT, "expiresAt" TIMESTAMPTZ NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(), "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE IF NOT EXISTS henri_auth."oauthConsent" (
        id TEXT PRIMARY KEY, "clientId" TEXT NOT NULL, "userId" TEXT NOT NULL,
        scopes TEXT NOT NULL, "consentGiven" BOOLEAN NOT NULL DEFAULT false,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(), "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
    ];
    for (const sql of tables) {
      await client.query(sql);
    }
    logger.info('Auth database tables ensured');
  } finally {
    client.release();
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function createHenriAuth(config: OAuthConfig): Promise<any> {
  let database: Parameters<typeof betterAuth>[0]['database'];

  if (config.databaseUrl) {
    const isRds = config.databaseUrl.includes('rds.amazonaws.com');
    const pool = new Pool({
      connectionString: config.databaseUrl,
      ssl: isRds ? { rejectUnauthorized: false } : undefined,
      options: '-c search_path=henri_auth,public',
    });
    await ensureAuthTables(pool);
    setAuthPool(pool);
    database = pool;
    logger.info({ rds: isRds }, 'OAuth using PostgreSQL for sessions');
  } else {
    logger.warn('No DATABASE_URL for OAuth — sessions will not persist');
    database = undefined as unknown as Parameters<typeof betterAuth>[0]['database'];
  }

  const auth = betterAuth({
    baseURL: config.baseURL,
    database,
    trustedOrigins: [config.baseURL],
    socialProviders: {
      google: {
        clientId: config.googleClientId,
        clientSecret: config.googleClientSecret,
        authorization: {
          params: { hd: config.allowedDomain },
        },
      },
    },
    emailAndPassword: { enabled: false },
    plugins: [
      mcp({
        loginPage: '/auth/sign-in',
        resource: config.mcpResourceURL,
        oidcConfig: {
          loginPage: '/auth/sign-in',
          accessTokenExpiresIn: 3600,
          refreshTokenExpiresIn: 604800,
          defaultScope: 'openid',
          scopes: ['openid', 'profile', 'email', 'offline_access'],
          allowDynamicClientRegistration: true,
        },
      }),
    ],
    advanced: {
      useSecureCookies: config.baseURL.startsWith('https://'),
    },
  });

  return auth;
}

// Store pool reference for user lookup
let authPool: Pool | null = null;

export function setAuthPool(pool: Pool): void {
  authPool = pool;
}

export async function getUserEmailFromToken(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  auth: any,
  authorizationHeader: string | undefined,
): Promise<{ userId: string; email: string } | null> {
  if (!authorizationHeader?.startsWith('Bearer ')) return null;

  try {
    const headers = new Headers();
    headers.set('Authorization', authorizationHeader);

    const session = await auth.api.getMcpSession({ headers });
    if (!session?.userId) return null;

    const userId = session.userId as string;

    // Look up email from henri_auth."user" table directly
    if (authPool) {
      const result = await authPool.query('SELECT email FROM henri_auth."user" WHERE id = $1', [
        userId,
      ]);
      if (result.rows.length > 0 && result.rows[0].email) {
        return { userId, email: result.rows[0].email };
      }
    }

    logger.warn({ userId }, 'MCP session valid but could not resolve email');
    return { userId, email: '' };
  } catch (err) {
    logger.warn({ error: err }, 'Failed to verify MCP token');
    return null;
  }
}

export { toNodeHandler, oAuthDiscoveryMetadata, oAuthProtectedResourceMetadata };
