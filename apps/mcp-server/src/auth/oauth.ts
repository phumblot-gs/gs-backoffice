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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createHenriAuth(config: OAuthConfig): any {
  let database: Parameters<typeof betterAuth>[0]['database'];

  if (config.databaseUrl) {
    let connString = config.databaseUrl;
    if (connString.includes('rds.amazonaws.com') && !connString.includes('sslmode')) {
      connString += connString.includes('?') ? '&sslmode=require' : '?sslmode=require';
    }
    const pool = new Pool({ connectionString: connString });
    database = pool;
    logger.info('OAuth using PostgreSQL for sessions');
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
