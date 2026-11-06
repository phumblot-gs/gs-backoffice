import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  configFromEnv,
  exchangeIdentityToken,
  JOB_FAILURE_MARKER,
  JWT_BEARER_GRANT,
  Refresher,
  TOKEN_ENDPOINT,
  writeSecretFileAtomic,
  type Deps,
  type FederationConfig,
} from './refresher.js';

const JWT = 'eyJ.PLANTED-JWT.sig';
const ACCESS = 'sk-ant-oat01-PLANTED-ACCESS-TOKEN';

function harness(over: Partial<Deps> = {}, cfgOver: Partial<FederationConfig> = {}) {
  let t = 1_000_000;
  const files = new Map<string, string>();
  const logs: Array<{ level: string; msg: string; meta?: Record<string, unknown> }> = [];
  const audiences: string[] = [];
  const durations: number[] = [];
  let n = 0;
  const fetchMock = vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(
        JSON.stringify({ access_token: ACCESS, token_type: 'Bearer', expires_in: 1800 }),
        { status: 200 },
      ),
  );
  const deps: Deps = {
    getIdentityToken: async (aud, seconds) => {
      audiences.push(aud);
      durations.push(seconds);
      return `${JWT}-${++n}`;
    },
    fetch: fetchMock as unknown as typeof fetch,
    now: () => t,
    writeSecretFile: (p, c) => void files.set(p, c),
    logger: {
      info: (msg, meta) => logs.push({ level: 'info', msg, meta }),
      error: (msg, meta) => logs.push({ level: 'error', msg, meta }),
    },
    ...over,
  };
  const cfg: FederationConfig = {
    agentsAudience: 'anthropic-agents',
    identityTokenFile: '/run/anthropic/identity.jwt',
    identityTokenSeconds: 300,
    sandbox: {
      audience: 'anthropic-sandbox',
      ruleId: 'fdrl_sandbox',
      organizationId: 'org-1',
      serviceAccountId: 'svac_sandbox',
      tokenFile: '/run/anthropic/sandbox-token',
      minRemainingSeconds: 1200,
      identityTokenSeconds: 900,
    },
    ...cfgOver,
  };
  return {
    refresher: new Refresher(cfg, deps),
    files,
    logs,
    audiences,
    durations,
    fetchMock,
    advance: (ms: number) => (t += ms),
  };
}

describe('Refresher', () => {
  it('writes the agents identity JWT and a sandbox access token', async () => {
    const h = harness();
    expect(await h.refresher.tick()).toBe(true);
    expect(h.files.get('/run/anthropic/identity.jwt')).toBe(`${JWT}-1`);
    expect(JSON.parse(h.files.get('/run/anthropic/sandbox-token')!)).toEqual({
      accessToken: ACCESS,
      expiresAt: 1_000_000 + 1800 * 1000,
    });
    expect(h.audiences).toEqual(['anthropic-agents', 'anthropic-sandbox']);
  });

  it('uses a fresh JWT for every sandbox exchange (jti stays single-use)', async () => {
    const h = harness();
    await h.refresher.tick();
    h.advance(11 * 60 * 1000); // 19 min left < 20 → re-mint
    await h.refresher.tick();
    const assertions = h.fetchMock.mock.calls.map((c) => JSON.parse(String(c[1]!.body)).assertion);
    expect(assertions).toHaveLength(2);
    expect(new Set(assertions).size).toBe(2);
  });

  it('asks STS for a JWT long enough to yield a 30-min sandbox token (2× cap)', async () => {
    const h = harness();
    await h.refresher.tick();
    expect(h.durations).toEqual([300, 900]);
    // Anthropic caps the access token at min(rule lifetime, 2 × JWT remaining lifetime).
    expect(Math.min(1800, 2 * h.durations[1])).toBeGreaterThanOrEqual(1800);
  });

  it('does not re-mint the sandbox token while enough lifetime remains', async () => {
    const h = harness();
    await h.refresher.tick();
    h.advance(3 * 60 * 1000);
    await h.refresher.tick();
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    expect(h.files.get('/run/anthropic/identity.jwt')).toBe(`${JWT}-3`); // identity refreshed every tick
  });

  it('sends the documented exchange request', async () => {
    const h = harness();
    await h.refresher.tick();
    const [url, init] = h.fetchMock.mock.calls[0];
    expect(url).toBe(TOKEN_ENDPOINT);
    expect(init!.method).toBe('POST');
    expect(JSON.parse(String(init!.body))).toEqual({
      grant_type: JWT_BEARER_GRANT,
      assertion: `${JWT}-2`,
      federation_rule_id: 'fdrl_sandbox',
      organization_id: 'org-1',
      service_account_id: 'svac_sandbox',
    });
  });

  it('logs failures with the job-failure marker and never a token', async () => {
    const h = harness({
      fetch: (async () =>
        new Response('{"error":{"reason":"match_subject_prefix"}}', {
          status: 401,
        })) as unknown as typeof fetch,
    });
    expect(await h.refresher.tick()).toBe(false);
    const err = h.logs.find((l) => l.level === 'error')!;
    expect(err.msg.startsWith(JOB_FAILURE_MARKER)).toBe(true);
    expect(String(err.meta?.error)).toContain('match_subject_prefix');
    expect(JSON.stringify(h.logs)).not.toMatch(/PLANTED/);
    expect(h.files.has('/run/anthropic/sandbox-token')).toBe(false);
  });

  it('keeps refreshing the identity file when STS fails once', async () => {
    let fail = true;
    const h = harness(
      {
        getIdentityToken: async () => {
          if (fail) {
            fail = false;
            throw new Error('OutboundWebIdentityFederationDisabled');
          }
          return JWT;
        },
      },
      { sandbox: undefined },
    );
    expect(await h.refresher.tick()).toBe(false);
    expect(h.logs[0].msg).toContain(JOB_FAILURE_MARKER);
    expect(await h.refresher.tick()).toBe(true);
    expect(h.files.get('/run/anthropic/identity.jwt')).toBe(JWT);
  });
});

describe('exchangeIdentityToken', () => {
  it('rejects a response without access_token', async () => {
    const f = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    await expect(
      exchangeIdentityToken(
        { fetch: f, now: () => 0 },
        { assertion: 'a', ruleId: 'r', organizationId: 'o', serviceAccountId: 's' },
      ),
    ).rejects.toThrow(/no access_token/);
  });

  it('passes workspace_id only when set', async () => {
    const f = vi.fn(
      async () =>
        new Response(JSON.stringify({ access_token: 'x', expires_in: 60 }), { status: 200 }),
    );
    await exchangeIdentityToken(
      { fetch: f as unknown as typeof fetch, now: () => 0 },
      {
        assertion: 'a',
        ruleId: 'r',
        organizationId: 'o',
        serviceAccountId: 's',
        workspaceId: 'wrkspc_1',
      },
    );
    expect(
      JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body))
        .workspace_id,
    ).toBe('wrkspc_1');
  });
});

describe('configFromEnv', () => {
  const base = {
    GS_ANTHROPIC_AGENTS_AUDIENCE: 'anthropic-agents',
    ANTHROPIC_IDENTITY_TOKEN_FILE: '/run/anthropic/identity.jwt',
  };
  it('agents only', () => {
    expect(configFromEnv(base).sandbox).toBeUndefined();
  });
  it('fails on a partial sandbox config', () => {
    expect(() => configFromEnv({ ...base, GS_ANTHROPIC_SANDBOX_RULE_ID: 'fdrl_x' })).toThrow(
      /required/,
    );
  });
  it('fails without the agents audience', () => {
    expect(() => configFromEnv({ ANTHROPIC_IDENTITY_TOKEN_FILE: '/x' })).toThrow(
      /GS_ANTHROPIC_AGENTS_AUDIENCE/,
    );
  });
});

describe('writeSecretFileAtomic', () => {
  it('writes owner-only', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'fed-')), 'token');
    writeSecretFileAtomic(p, 'secret');
    expect(readFileSync(p, 'utf8')).toBe('secret');
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });
});
