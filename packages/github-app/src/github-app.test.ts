import { describe, it, expect, beforeEach } from 'vitest';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import {
  hasGitHubApp,
  buildAppJwt,
  mintInstallationToken,
  resolveGitHubToken,
  __resetTokenCache,
} from './github-app.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const APP_ENV = {
  GITHUB_APP_ID: '4168279',
  GITHUB_APP_INSTALLATION_ID: '143161925',
  GITHUB_APP_PRIVATE_KEY: privateKey,
} as NodeJS.ProcessEnv;

beforeEach(() => __resetTokenCache());

describe('hasGitHubApp', () => {
  it('is true when all three credentials are set', () => {
    expect(hasGitHubApp(APP_ENV)).toBe(true);
  });
  it('is false when a value is missing', () => {
    expect(
      hasGitHubApp({ GITHUB_APP_ID: 'x', GITHUB_APP_INSTALLATION_ID: 'y' } as NodeJS.ProcessEnv),
    ).toBe(false);
  });
  it('treats the CHANGE_ME placeholder as absent', () => {
    expect(
      hasGitHubApp({ ...APP_ENV, GITHUB_APP_PRIVATE_KEY: 'CHANGE_ME' } as NodeJS.ProcessEnv),
    ).toBe(false);
  });
});

describe('buildAppJwt', () => {
  it('signs a verifiable RS256 JWT with iss/iat/exp', () => {
    const jwt = buildAppJwt('4168279', privateKey, 1_000_000);
    const [h, p, sig] = jwt.split('.');
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });
    expect(JSON.parse(Buffer.from(p, 'base64url').toString())).toEqual({
      iat: 1_000_000 - 60,
      exp: 1_000_000 + 540,
      iss: '4168279',
    });
    const v = createVerify('RSA-SHA256');
    v.update(`${h}.${p}`);
    v.end();
    expect(v.verify(publicKey, Buffer.from(sig, 'base64url'))).toBe(true);
  });
});

describe('mintInstallationToken', () => {
  it('exchanges the JWT for an installation token and caches it', async () => {
    let calls = 0;
    const f = (async (url: string, init: RequestInit) => {
      calls += 1;
      expect(url).toContain('/app/installations/143161925/access_tokens');
      expect((init.headers as Record<string, string>).Authorization).toMatch(/^Bearer /);
      return {
        ok: true,
        status: 201,
        text: async () =>
          JSON.stringify({
            token: 'ghs_xxx',
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          }),
      };
    }) as never;
    expect(await mintInstallationToken(APP_ENV, f)).toBe('ghs_xxx');
    // cached → a throwing fetch must not be hit on the second call
    expect(
      await mintInstallationToken(APP_ENV, (async () => {
        throw new Error('should not refetch');
      }) as never),
    ).toBe('ghs_xxx');
    expect(calls).toBe(1);
  });

  it('throws on a failed exchange', async () => {
    const f = (async () => ({ ok: false, status: 401, text: async () => 'bad jwt' })) as never;
    await expect(mintInstallationToken(APP_ENV, f)).rejects.toThrow(/token exchange → HTTP 401/);
  });

  it('throws when the App env is incomplete', async () => {
    await expect(
      mintInstallationToken(
        {} as NodeJS.ProcessEnv,
        (async () => {
          throw new Error('unused');
        }) as never,
      ),
    ).rejects.toThrow(/env incomplete/);
  });
});

describe('resolveGitHubToken', () => {
  it('mints an App token when the App is configured', async () => {
    const f = (async () => ({
      ok: true,
      status: 201,
      text: async () => JSON.stringify({ token: 'ghs_app' }),
    })) as never;
    expect(await resolveGitHubToken({ env: APP_ENV, mintFetch: f, patFallback: () => 'pat' })).toBe(
      'ghs_app',
    );
  });

  it('falls back to the PAT when no App is configured', async () => {
    expect(
      await resolveGitHubToken({ env: {} as NodeJS.ProcessEnv, patFallback: () => 'pat' }),
    ).toBe('pat');
  });
});
