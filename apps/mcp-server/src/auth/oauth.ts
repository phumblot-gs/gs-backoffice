import { betterAuth } from 'better-auth';
import { mcp } from 'better-auth/plugins';
import { oAuthDiscoveryMetadata, oAuthProtectedResourceMetadata } from 'better-auth/plugins';
import { toNodeHandler } from 'better-auth/node';
import Database from 'better-sqlite3';
import pino from 'pino';

const logger = pino({ name: 'oauth' });

export interface OAuthConfig {
  baseURL: string;
  mcpResourceURL: string;
  googleClientId: string;
  googleClientSecret: string;
  allowedDomain: string;
}

function initializeSchema(db: InstanceType<typeof Database>): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      emailVerified INTEGER NOT NULL DEFAULT 0,
      image TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS session (
      id TEXT PRIMARY KEY,
      token TEXT NOT NULL UNIQUE,
      expiresAt TEXT NOT NULL,
      ipAddress TEXT,
      userAgent TEXT,
      userId TEXT NOT NULL REFERENCES user(id),
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS account (
      id TEXT PRIMARY KEY,
      accountId TEXT NOT NULL,
      providerId TEXT NOT NULL,
      userId TEXT NOT NULL REFERENCES user(id),
      accessToken TEXT,
      refreshToken TEXT,
      idToken TEXT,
      accessTokenExpiresAt TEXT,
      refreshTokenExpiresAt TEXT,
      scope TEXT,
      password TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS verification (
      id TEXT PRIMARY KEY,
      identifier TEXT NOT NULL,
      value TEXT NOT NULL,
      expiresAt TEXT NOT NULL,
      createdAt TEXT,
      updatedAt TEXT
    );
    CREATE TABLE IF NOT EXISTS oauthApplication (
      id TEXT PRIMARY KEY,
      name TEXT,
      icon TEXT,
      metadata TEXT,
      clientId TEXT NOT NULL UNIQUE,
      clientSecret TEXT,
      redirectUrls TEXT NOT NULL,
      type TEXT NOT NULL,
      disabled INTEGER NOT NULL DEFAULT 0,
      userId TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS oauthAccessToken (
      id TEXT PRIMARY KEY,
      accessToken TEXT NOT NULL UNIQUE,
      refreshToken TEXT UNIQUE,
      accessTokenExpiresAt TEXT NOT NULL,
      refreshTokenExpiresAt TEXT,
      clientId TEXT NOT NULL,
      userId TEXT,
      scopes TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS oauthRefreshToken (
      id TEXT PRIMARY KEY,
      refreshToken TEXT NOT NULL UNIQUE,
      accessTokenId TEXT NOT NULL,
      expiresAt TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS oauthAuthorizationCode (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      clientId TEXT NOT NULL,
      userId TEXT,
      scopes TEXT NOT NULL,
      redirectURI TEXT NOT NULL,
      codeChallenge TEXT,
      codeChallengeMethod TEXT,
      expiresAt TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS oauthConsent (
      id TEXT PRIMARY KEY,
      clientId TEXT NOT NULL,
      userId TEXT NOT NULL,
      scopes TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      consentGiven INTEGER NOT NULL DEFAULT 0
    );
  `);
  logger.info('Auth database schema initialized (in-memory)');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createHenriAuth(config: OAuthConfig): any {
  const db = new Database(':memory:');
  initializeSchema(db);

  const auth = betterAuth({
    baseURL: config.baseURL,
    database: db as unknown as Parameters<typeof betterAuth>[0]['database'],
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

export async function getUserEmailFromToken(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  auth: any,
  authorizationHeader: string | undefined,
): Promise<{ userId: string; email: string } | null> {
  if (!authorizationHeader?.startsWith('Bearer ')) return null;

  try {
    const headers = new Headers();
    headers.set('Authorization', authorizationHeader);

    // Get MCP session from the access token
    const session = await auth.api.getMcpSession({ headers });
    if (!session?.userId) return null;

    // Get user session to retrieve email
    const userSession = await auth.api.getSession({ headers });
    const email = userSession?.user?.email as string | undefined;

    if (!email) {
      logger.warn({ userId: session.userId }, 'MCP session valid but no user email found');
      return { userId: session.userId as string, email: '' };
    }

    return {
      userId: session.userId as string,
      email,
    };
  } catch (err) {
    logger.warn({ error: err }, 'Failed to verify MCP token');
    return null;
  }
}

export { toNodeHandler, oAuthDiscoveryMetadata, oAuthProtectedResourceMetadata };
