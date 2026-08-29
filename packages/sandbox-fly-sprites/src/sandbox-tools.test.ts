import { describe, it, expect, afterEach, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { __resetTokenCache } from '@gs-backoffice/github-app';
import {
  buildGitCredentialSetup,
  buildCheckoutScript,
  buildCodeTaskCheckoutScript,
  buildFormatScript,
  DEFAULT_CODE_MODEL,
  SANDBOX_WORK_DIR,
} from './sandbox.js';
import {
  spriteNameForKey,
  parseSandboxRunParams,
  parseCodeTaskParams,
  reapIdleSandboxes,
  resolveGitHubCredential,
  resolveSecret,
} from './tools.js';
import type { PluginContext } from '@paperclipai/plugin-sdk';

describe('buildGitCredentialSetup', () => {
  it('uses a credential helper reading $GH_TOKEN (no token in url/config)', () => {
    const s = buildGitCredentialSetup();
    expect(s).toContain('credential.helper');
    expect(s).toContain('password=$GH_TOKEN');
    expect(s).not.toMatch(/https:\/\/[^@\s]*@/); // never embeds a token in a URL
  });
});

describe('buildCheckoutScript', () => {
  it('reuses the clone only when origin matches (repo-match guard), else re-clones', () => {
    const s = buildCheckoutScript({
      repoUrl: 'https://github.com/org/repo.git',
      ref: 'main',
      workDir: SANDBOX_WORK_DIR,
    });
    expect(s).toContain('git remote get-url origin');
    expect(s).toContain("'https://github.com/org/repo.git'");
    expect(s).toContain('git clone');
    expect(s).toContain('git fetch origin --prune');
    // checks out the ref, with a branch-tracking fallback
    expect(s).toContain("git checkout --quiet 'main'");
    expect(s).toContain("origin/'main'");
  });

  it('shell-quotes a ref to resist injection', () => {
    const s = buildCheckoutScript({ repoUrl: 'r', ref: 'x; rm -rf /', workDir: '/w' });
    expect(s).toContain(`'x; rm -rf /'`);
    expect(s).not.toMatch(/checkout --quiet x; rm/);
  });
});

describe('spriteNameForKey', () => {
  it('produces a valid lowercase Fly sprite name', () => {
    expect(spriteNameForKey('audit-GRA-12')).toBe('sandbox-audit-gra-12');
    expect(spriteNameForKey('Proj/Repo #1')).toBe('sandbox-proj-repo-1');
    expect(spriteNameForKey('')).toBe('sandbox-default');
    expect(spriteNameForKey('audit-GRA-12')).toMatch(/^sandbox-[a-z0-9-]+$/);
  });
});

describe('parseSandboxRunParams', () => {
  it('accepts a complete payload', () => {
    const r = parseSandboxRunParams({
      sandboxKey: 'audit-1',
      repoUrl: 'https://x/r.git',
      ref: 'feat/x',
      command: 'pnpm test',
      credMode: 'read_only',
      timeoutMs: 60000,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.credMode).toBe('read_only');
      expect(r.value.timeoutMs).toBe(60000);
    }
  });

  it('defaults credMode to read_only and drops invalid timeout', () => {
    const r = parseSandboxRunParams({
      sandboxKey: 'k',
      repoUrl: 'u',
      ref: 'r',
      command: 'c',
      timeoutMs: -5,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.credMode).toBe('read_only');
      expect(r.value.timeoutMs).toBeUndefined();
    }
  });

  it('rejects missing required params', () => {
    const r = parseSandboxRunParams({ sandboxKey: 'k', repoUrl: 'u', ref: 'r' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/command/);
  });
});

describe('buildCodeTaskCheckoutScript', () => {
  it('continues an existing target branch, else branches from base', () => {
    const s = buildCodeTaskCheckoutScript({
      repoUrl: 'https://github.com/org/repo.git',
      baseBranch: 'main',
      targetBranch: 'eng/x',
      workDir: SANDBOX_WORK_DIR,
    });
    expect(s).toContain('git clone');
    expect(s).toContain('git remote get-url origin');
    expect(s).toContain('refs/remotes/origin/$TB'); // continue target branch if it exists
    expect(s).toContain('git checkout -B "$TB" "origin/$TB"');
    expect(s).toContain('git checkout -B "$TB" "origin/$BB"'); // else from base
    expect(s).toContain('credential.helper');
  });
});

describe('DEFAULT_CODE_MODEL', () => {
  it('pins the in-sandbox coding default to Sonnet (cost), not the CLI default', () => {
    expect(DEFAULT_CODE_MODEL).toBe('claude-sonnet-4-6');
  });
});

describe('buildFormatScript', () => {
  it('runs the repo prettier via pnpm, best-effort (every step tolerates failure)', () => {
    const s = buildFormatScript(SANDBOX_WORK_DIR);
    expect(s).toContain(`cd '${SANDBOX_WORK_DIR}'`);
    expect(s).toContain('corepack enable');
    expect(s).toContain('pnpm install');
    expect(s).toContain('pnpm format');
    expect(s).toContain('prettier --write .'); // fallback if `pnpm format` is unavailable
    // Best-effort: no step may abort the task.
    expect(s).toContain('|| true');
    expect(s).toContain('|| exit 0');
  });
});

describe('parseCodeTaskParams', () => {
  it('accepts a complete payload', () => {
    const r = parseCodeTaskParams({
      sandboxKey: 'eng-1',
      repoUrl: 'https://x/r.git',
      baseBranch: 'develop',
      targetBranch: 'eng/feat',
      task: 'add a file',
      model: 'claude-x',
      timeoutMs: 120000,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.baseBranch).toBe('develop');
      expect(r.value.targetBranch).toBe('eng/feat');
      expect(r.value.timeoutMs).toBe(120000);
    }
  });

  it('defaults baseBranch to main', () => {
    const r = parseCodeTaskParams({ sandboxKey: 'k', repoUrl: 'u', targetBranch: 't', task: 'do' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.baseBranch).toBe('main');
  });

  it('rejects missing task', () => {
    const r = parseCodeTaskParams({ sandboxKey: 'k', repoUrl: 'u', targetBranch: 't' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/task/);
  });
});

describe('reapIdleSandboxes', () => {
  const DAY = 24 * 60 * 60 * 1000;
  function fakeCtx(state: Record<string, unknown>): {
    ctx: PluginContext;
    state: Record<string, unknown>;
  } {
    const ctx = {
      state: {
        get: async (k: { stateKey: string }) => state[k.stateKey] ?? null,
        set: async (k: { stateKey: string }, v: unknown) => {
          state[k.stateKey] = v;
        },
        delete: async (k: { stateKey: string }) => {
          delete state[k.stateKey];
        },
      },
    } as unknown as PluginContext;
    return { ctx, state };
  }

  it('deletes only sandboxes idle beyond the TTL; leaves fresh + untracked ones', async () => {
    const now = 100 * DAY;
    const state: Record<string, unknown> = {
      'sandbox-old': { lastUsedAt: now - 8 * DAY }, // idle > 7d → delete
      'sandbox-fresh': { lastUsedAt: now - 1 * DAY }, // recent → keep
      // 'sandbox-untracked' has no state → keep (avoid racing a create)
    };
    const { ctx } = fakeCtx(state);
    const deletedCalls: string[] = [];
    const client = {
      listAllSprites: async () => [
        { name: 'sandbox-old' },
        { name: 'sandbox-fresh' },
        { name: 'sandbox-untracked' },
      ],
      deleteSprite: async (n: string) => {
        deletedCalls.push(n);
      },
    } as never;

    const res = await reapIdleSandboxes(ctx, { ttlDays: 7, spritesToken: 'x', now, client });
    expect(res.checked).toBe(3);
    expect(res.deleted).toEqual(['sandbox-old']);
    expect(deletedCalls).toEqual(['sandbox-old']);
    expect(state['sandbox-old']).toBeUndefined(); // state row cleared
    expect(state['sandbox-fresh']).toBeDefined();
  });
});

describe('resolveGitHubCredential (App-first credential selection)', () => {
  const logger = () => {
    const warns: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
    return {
      warns,
      logger: {
        info: () => {},
        warn: (msg: string, meta?: Record<string, unknown>) => warns.push({ msg, meta }),
        error: () => {},
        debug: () => {},
      } as unknown as PluginContext['logger'],
    };
  };

  afterEach(() => {
    __resetTokenCache();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function stubApp() {
    vi.stubEnv('GITHUB_APP_ID', '4168279');
    vi.stubEnv('GITHUB_APP_INSTALLATION_ID', '111');
    // Throwaway key generated per-run: the JWT only needs to be signable here.
    vi.stubEnv(
      'GITHUB_APP_PRIVATE_KEY',
      generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
      }).privateKey,
    );
  }

  it('prefers the App installation token over the PAT', async () => {
    stubApp();
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 201,
      text: async () => JSON.stringify({ token: 'ghs_app', expires_at: null }),
    }));
    const { logger: log } = logger();
    expect(await resolveGitHubCredential(() => 'ghp_pat', log)).toBe('ghs_app');
  });

  it('falls back to the PAT when no App is configured', async () => {
    const { logger: log, warns } = logger();
    expect(await resolveGitHubCredential(() => 'ghp_pat', log)).toBe('ghp_pat');
    expect(warns).toHaveLength(0);
  });

  it('degrades to the PAT (with a warning) when minting fails', async () => {
    stubApp();
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 401, text: async () => 'bad key' }));
    const { logger: log, warns } = logger();
    expect(await resolveGitHubCredential(() => 'ghp_pat', log)).toBe('ghp_pat');
    expect(warns[0]?.msg).toMatch(/falling back to the PAT/);
  });

  it('returns undefined when neither an App nor a PAT is available', async () => {
    const { logger: log } = logger();
    expect(await resolveGitHubCredential(() => undefined, log)).toBeUndefined();
  });
});

describe('resolveSecret (native secret store first, env as fallback)', () => {
  const mkCtx = () => {
    const warns: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
    const make = (resolve: (ref: unknown) => Promise<string>) =>
      ({
        secrets: { resolve },
        logger: {
          info: () => {},
          warn: (msg: string, meta?: Record<string, unknown>) => warns.push({ msg, meta }),
          error: () => {},
          debug: () => {},
        },
      }) as unknown as PluginContext;
    return { warns, make };
  };

  afterEach(() => vi.unstubAllEnvs());

  it('uses the resolved reference and never reads the env', async () => {
    const { make } = mkCtx();
    vi.stubEnv('SPRITES_TOKEN', 'from-env');
    const ctx = make(async () => 'from-store');
    const cfg = { spritesToken: { type: 'secret_ref', secretId: 'abc' } };
    await expect(
      resolveSecret(ctx, cfg, 'spritesToken', 'spritesTokenEnv', 'SPRITES_TOKEN'),
    ).resolves.toBe('from-store');
  });

  it('falls back to the env when the reference fails to resolve, and says so', async () => {
    const { make, warns } = mkCtx();
    vi.stubEnv('SPRITES_TOKEN', 'from-env');
    const ctx = make(async () => {
      throw new Error('provider unavailable');
    });
    const cfg = { spritesToken: { type: 'secret_ref', secretId: 'abc' } };
    await expect(
      resolveSecret(ctx, cfg, 'spritesToken', 'spritesTokenEnv', 'SPRITES_TOKEN'),
    ).resolves.toBe('from-env');
    // A silently empty credential is how one goes missing unnoticed.
    expect(warns[0]?.msg).toMatch(/could not be resolved/);
  });

  it('falls back — and warns — when the reference resolves to an empty value', async () => {
    const { make, warns } = mkCtx();
    vi.stubEnv('SPRITES_TOKEN', 'from-env');
    const ctx = make(async () => '   ');
    const cfg = { spritesToken: { type: 'secret_ref', secretId: 'abc' } };
    await expect(
      resolveSecret(ctx, cfg, 'spritesToken', 'spritesTokenEnv', 'SPRITES_TOKEN'),
    ).resolves.toBe('from-env');
    expect(warns[0]?.msg).toMatch(/empty value/);
  });

  it('uses the env when no reference is configured — the pre-migration path', async () => {
    const { make, warns } = mkCtx();
    vi.stubEnv('SPRITES_TOKEN', 'from-env');
    const ctx = make(async () => 'unused');
    await expect(
      resolveSecret(ctx, {}, 'spritesToken', 'spritesTokenEnv', 'SPRITES_TOKEN'),
    ).resolves.toBe('from-env');
    expect(warns).toHaveLength(0);
  });
});
