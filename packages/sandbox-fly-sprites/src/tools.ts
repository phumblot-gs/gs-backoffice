import type { PluginContext, ToolResult, ScopeKey } from '@paperclipai/plugin-sdk';
import type { SpritesClient, Sprite } from '@fly/sprites';
import { flyClient } from './exec.js';
import { sandboxRun, sandboxCodeTask } from './sandbox.js';
import { runPrReviewDigest, emitChatNotify } from './digest.js';
import { resolveGitHubToken } from '@gs-backoffice/github-app';

/**
 * Stable marker logged whenever a scheduled job cannot do its job.
 *
 * The CloudWatch metric filter and alarm in
 * `infrastructure/terraform/modules/monitoring/main.tf` count occurrences of this
 * exact string, so it must not change without updating the Terraform pattern.
 * Infra alarms (CPU, 5xx) cannot see a job that fails while the service stays
 * healthy — this marker is what makes that visible.
 */
export const JOB_FAILURE_MARKER = 'BACKOFFICE_JOB_FAILURE';

/** Fly Sprite names must be lowercase alphanumeric + hyphens. Derive a stable,
 *  collision-resistant name from the caller's `sandboxKey`. Pure (testable). */
export function spriteNameForKey(sandboxKey: string): string {
  const slug = sandboxKey
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `sandbox-${slug || 'default'}`;
}

interface SandboxRunParams {
  sandboxKey: string;
  repoUrl: string;
  ref: string;
  command: string;
  credMode?: 'read_only' | 'push';
  timeoutMs?: number;
}

/** Validate + normalize raw tool params. Returns an error string if invalid. Pure. */
export function parseSandboxRunParams(
  raw: unknown,
): { ok: true; value: SandboxRunParams } | { ok: false; error: string } {
  const p = (raw ?? {}) as Record<string, unknown>;
  const need = (k: string) => typeof p[k] === 'string' && (p[k] as string).trim().length > 0;
  for (const k of ['sandboxKey', 'repoUrl', 'ref', 'command']) {
    if (!need(k)) return { ok: false, error: `Missing or empty required parameter: ${k}` };
  }
  const credMode = p.credMode === 'push' ? 'push' : 'read_only';
  const timeoutMs =
    typeof p.timeoutMs === 'number' && Number.isFinite(p.timeoutMs) && p.timeoutMs > 0
      ? Math.trunc(p.timeoutMs)
      : undefined;
  return {
    ok: true,
    value: {
      sandboxKey: (p.sandboxKey as string).trim(),
      repoUrl: (p.repoUrl as string).trim(),
      ref: (p.ref as string).trim(),
      command: p.command as string,
      credMode,
      timeoutMs,
    },
  };
}

const SANDBOX_RUN_SCHEMA = {
  type: 'object',
  required: ['sandboxKey', 'repoUrl', 'ref', 'command'],
  additionalProperties: false,
  properties: {
    sandboxKey: {
      type: 'string',
      description:
        'Stable id scoping Sprite reuse, tied to repo + role (e.g. "audit-GRA-12"). Same key reuses the same microVM (cold between calls); distinct keys never share a sandbox.',
    },
    repoUrl: {
      type: 'string',
      description: 'Git URL to clone (per project, e.g. https://github.com/org/repo.git).',
    },
    ref: { type: 'string', description: 'Branch name or commit SHA to check out before running.' },
    command: {
      type: 'string',
      description:
        'Command to run in the repo directory (via `sh -c`), e.g. "pnpm test", "semgrep --config auto .". Does not push.',
    },
    credMode: {
      type: 'string',
      enum: ['read_only', 'push'],
      default: 'read_only',
      description:
        'Which GitHub credential to expose to git in the sandbox. Verification uses read_only.',
    },
    timeoutMs: { type: 'number', description: 'Hard wall-clock limit for the command (ms).' },
  },
} as const;

/**
 * Read a token from the worker env — the LEGACY path, now only a fallback behind
 * `resolveSecret`. It exists because Paperclip 2026.609.0 gave a plugin tool no
 * working secret-resolution path (ctx.secrets.resolve threw), so secrets had to reach
 * the worker via the env passthrough (injected by Terraform, forwarded by our
 * plugin-loader patch). 2026.824.1 lifted that restriction. Keep this until the EVT
 * and Paperclip API keys have moved to references too — only then can the patch go.
 * An optional config field can override the env-var name. Pure-ish (reads process.env).
 */
function envSecret(
  cfg: Record<string, unknown>,
  overrideKey: string,
  defaultEnvName: string,
): string | undefined {
  const envName =
    typeof cfg[overrideKey] === 'string' && (cfg[overrideKey] as string).trim()
      ? (cfg[overrideKey] as string).trim()
      : defaultEnvName;
  const value = process.env[envName];
  return value && value.trim() ? value : undefined;
}

/**
 * Resolve one secret, preferring Paperclip's native secret store over the env.
 *
 * `ctx.secrets.resolve()` only became usable for plugin tools in 2026.824.1 — in
 * 2026.609.0 it threw, which is why the worker env passthrough patch exists at all.
 * The env fallback is kept deliberately: it lets this migration deploy before any
 * operator has filled in the references, and it is the seam that lets the patch be
 * retired later without a flag day.
 *
 * A resolution failure is NOT swallowed silently — it falls back to the env, but says
 * so, because a reference that quietly resolves to nothing is how a credential goes
 * missing without anyone noticing.
 */
export async function resolveSecret(
  ctx: PluginContext,
  cfg: Record<string, unknown>,
  refKey: string,
  envOverrideKey: string,
  defaultEnvName: string,
): Promise<string | undefined> {
  const ref = cfg[refKey];
  if (ref && (typeof ref === 'string' || typeof ref === 'object')) {
    try {
      const value = await ctx.secrets.resolve(ref as Parameters<typeof ctx.secrets.resolve>[0]);
      if (value && value.trim()) {
        // Positive signal, on purpose. Only failures were logged, so "no warning" was
        // compatible with two opposite realities: the reference resolved, or the worker
        // never saw one and took the env fallback silently. The env path is due to be
        // removed — deciding that on an ambiguous signal is how a credential goes
        // missing. Never logs the value, only which field resolved.
        ctx.logger.info('secret resolved from the Paperclip store', { refKey });
        return value;
      }
      ctx.logger.warn('secret reference resolved to an empty value — falling back to the env', {
        refKey,
      });
    } catch (err) {
      ctx.logger.warn('secret reference could not be resolved — falling back to the env', {
        refKey,
        error: String(err),
      });
    }
  }
  return envSecret(cfg, envOverrideKey, defaultEnvName);
}

/**
 * The GitHub credential to use: a short-lived GitHub App installation token when the
 * App is configured, else the PAT.
 *
 * Preferring the App is what stops a long-lived token from expiring unnoticed — the
 * PR-review digest spent a month posting "no PRs to review" on the back of a dead PAT.
 * A mint failure degrades to the PAT instead of failing the call outright, so a
 * half-configured App never takes the sandbox down.
 */
export async function resolveGitHubCredential(
  pat: () => Promise<string | undefined> | string | undefined,
  logger: PluginContext['logger'],
): Promise<string | undefined> {
  const fallback = async () => (await pat()) ?? '';
  try {
    // resolveGitHubToken takes a sync fallback; resolve ours first so a secret-ref
    // lookup can be awaited before handing the value over.
    const pre = await fallback();
    const token = await resolveGitHubToken({ patFallback: () => pre });
    if (token) return token;
  } catch (err) {
    logger.warn('github-app: installation token unavailable — falling back to the PAT', {
      error: String(err),
    });
  }
  return fallback().then((v) => v || undefined);
}

interface CodeTaskParams {
  sandboxKey: string;
  repoUrl: string;
  baseBranch: string;
  targetBranch: string;
  task: string;
  model?: string;
  timeoutMs?: number;
}

/** Validate + normalize sandbox_code_task params. Pure. */
export function parseCodeTaskParams(
  raw: unknown,
): { ok: true; value: CodeTaskParams } | { ok: false; error: string } {
  const p = (raw ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof p[k] === 'string' ? (p[k] as string) : '');
  for (const k of ['sandboxKey', 'repoUrl', 'targetBranch', 'task']) {
    if (!str(k).trim()) return { ok: false, error: `Missing or empty required parameter: ${k}` };
  }
  const timeoutMs =
    typeof p.timeoutMs === 'number' && Number.isFinite(p.timeoutMs) && p.timeoutMs > 0
      ? Math.trunc(p.timeoutMs)
      : undefined;
  return {
    ok: true,
    value: {
      sandboxKey: str('sandboxKey').trim(),
      repoUrl: str('repoUrl').trim(),
      baseBranch: str('baseBranch').trim() || 'main',
      targetBranch: str('targetBranch').trim(),
      task: p.task as string,
      model: str('model').trim() || undefined,
      timeoutMs,
    },
  };
}

/** Get a handle to the sandbox's Sprite, creating it if absent. */
async function ensureSprite(client: SpritesClient, name: string, region: string): Promise<Sprite> {
  try {
    return await client.getSprite(name);
  } catch {
    return await client.createSprite(name, { region });
  }
}

// --- Idle tracking + reaper (Sprites expose no reliable last-activity, so we
// track last-use ourselves in instance-scoped plugin state, keyed by sprite name). ---
const lastUsedKey = (name: string): ScopeKey => ({
  scopeKind: 'instance',
  namespace: 'sandbox-lastused',
  stateKey: name,
});

/** Mark a sandbox as just used (best-effort). */
async function touchSandbox(ctx: PluginContext, name: string): Promise<void> {
  try {
    await ctx.state.set(lastUsedKey(name), { lastUsedAt: Date.now() });
  } catch {
    /* best-effort: tracking failure must not fail the tool call */
  }
}

/** Forget a released sandbox's usage record (best-effort). */
async function forgetSandbox(ctx: PluginContext, name: string): Promise<void> {
  try {
    await ctx.state.delete(lastUsedKey(name));
  } catch {
    /* best-effort */
  }
}

/**
 * Delete sandbox Sprites idle longer than `ttlDays` (tracked via plugin state).
 * Untracked Sprites (no state row) are left alone to avoid racing a fresh create.
 * Backstop to `sandbox_release`; bounds cold-storage cost. Exported for testing.
 */
export async function reapIdleSandboxes(
  ctx: PluginContext,
  opts: {
    ttlDays: number;
    spritesToken: string;
    now: number;
    /** Injectable for tests; defaults to a real Fly client. */
    client?: Pick<SpritesClient, 'listAllSprites' | 'deleteSprite'>;
  },
): Promise<{ checked: number; deleted: string[] }> {
  const client = opts.client ?? flyClient(opts.spritesToken);
  const ttlMs = opts.ttlDays * 24 * 60 * 60 * 1000;
  const sprites = await client.listAllSprites('sandbox-').catch(() => []);
  const deleted: string[] = [];
  for (const sprite of sprites) {
    const name = sprite.name;
    if (!name || !name.startsWith('sandbox-')) continue;
    const state = (await ctx.state.get(lastUsedKey(name)).catch(() => null)) as {
      lastUsedAt?: number;
    } | null;
    const lastUsedAt = state && typeof state.lastUsedAt === 'number' ? state.lastUsedAt : null;
    if (lastUsedAt === null) continue; // untracked → leave (avoid racing a create)
    if (opts.now - lastUsedAt > ttlMs) {
      await client.deleteSprite(name).catch(() => undefined);
      await ctx.state.delete(lastUsedKey(name)).catch(() => undefined);
      deleted.push(name);
    }
  }
  return { checked: sprites.length, deleted };
}

export function registerSandboxTools(ctx: PluginContext): void {
  ctx.tools.register(
    'sandbox_run',
    {
      displayName: 'Run a command in a sandbox',
      description:
        'Run an arbitrary command in an isolated, reusable Fly Sprite microVM with a repo checked out at a given git ref, and return the captured exit code + output. Use for verification: tests (`pnpm test`), code scanners (`semgrep`, `trivy`), pentest tools, lint, build. Reuses the sandbox keyed by `sandboxKey`. Does not push — for editing+pushing use sandbox_code_task.',
      parametersSchema: SANDBOX_RUN_SCHEMA,
    },
    async (params): Promise<ToolResult> => {
      const parsed = parseSandboxRunParams(params);
      if (!parsed.ok) return { error: parsed.error };
      const input = parsed.value;

      const cfg = await ctx.config.get().catch(() => ({}) as Record<string, unknown>);
      const region =
        typeof cfg.region === 'string' && cfg.region.trim() ? cfg.region.trim() : 'cdg';
      const timeoutMs = typeof cfg.timeoutMs === 'number' ? cfg.timeoutMs : undefined;

      const spritesToken = await resolveSecret(
        ctx,
        cfg,
        'spritesToken',
        'spritesTokenEnv',
        'SPRITES_TOKEN',
      );
      if (!spritesToken) {
        return {
          error:
            'Fly Sprites token unavailable in the worker env (expected SPRITES_TOKEN; ensure the plugin-loader env passthrough patch is applied and the secret is set).',
        };
      }
      // App installation token first; the PATs stay as the fallback. Within the PATs,
      // a READ-only token when configured, else the push token, else the combined one
      // (least privilege per role; single-token fallback).
      const githubToken = await resolveGitHubCredential(
        async () =>
          (input.credMode === 'push'
            ? await resolveSecret(
                ctx,
                cfg,
                'githubPushToken',
                'githubPushTokenEnv',
                'SANDBOX_GITHUB_PUSH_TOKEN',
              )
            : await resolveSecret(
                ctx,
                cfg,
                'githubReadToken',
                'githubReadTokenEnv',
                'SANDBOX_GITHUB_READ_TOKEN',
              )) ??
          (await resolveSecret(ctx, cfg, 'githubToken', 'githubTokenEnv', 'SANDBOX_GITHUB_TOKEN')),
        ctx.logger,
      );

      const client = flyClient(spritesToken);
      const name = spriteNameForKey(input.sandboxKey);
      const sprite = await ensureSprite(client, name, region);
      await touchSandbox(ctx, name);

      try {
        const r = await sandboxRun(sprite, {
          repoUrl: input.repoUrl,
          ref: input.ref,
          command: input.command,
          githubToken,
          timeoutMs: input.timeoutMs ?? timeoutMs,
        });
        const ok = r.exitCode === 0 && !r.timedOut;
        const content = r.timedOut
          ? `Command timed out in sandbox "${name}" at ref ${input.ref}.`
          : `Command exited ${r.exitCode} in sandbox "${name}" at ${r.checkedOutSha?.slice(0, 12) ?? input.ref}.`;
        return {
          content,
          data: {
            sandboxKey: input.sandboxKey,
            spriteName: name,
            ref: input.ref,
            checkedOutSha: r.checkedOutSha,
            exitCode: r.exitCode,
            timedOut: r.timedOut,
            ok,
            stdout: r.stdout,
            stderr: r.stderr,
          },
        };
      } catch (error) {
        return {
          error: `sandbox_run failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  );

  ctx.tools.register(
    'sandbox_code_task',
    {
      displayName: 'Run a coding task with Claude in a sandbox',
      description:
        'Run Claude in an isolated, reusable Fly Sprite to perform a coding task on a branch, then commit and push the result to GitHub from inside the sandbox. Reuses the sandbox keyed by `sandboxKey` (re-invoke to iterate on the same branch). Returns the branch, head SHA, and Claude’s summary; review the diff with your GitHub tools.',
      parametersSchema: {
        type: 'object',
        required: ['sandboxKey', 'repoUrl', 'targetBranch', 'task'],
        additionalProperties: false,
        properties: {
          sandboxKey: {
            type: 'string',
            description: 'Stable id scoping Sprite reuse (tie to repo + issue, e.g. "eng-GRA-12").',
          },
          repoUrl: { type: 'string', description: 'Git URL to clone (per project).' },
          baseBranch: {
            type: 'string',
            description: 'Branch to start from when the target branch is new (default "main").',
          },
          targetBranch: { type: 'string', description: 'Branch to commit + push the work to.' },
          task: {
            type: 'string',
            description: 'Instruction for Claude (it edits files; the tool commits + pushes).',
          },
          model: {
            type: 'string',
            description:
              'Claude model for the in-sandbox coding run. Defaults to Sonnet; pass a Haiku model for trivial edits to save cost.',
          },
          timeoutMs: {
            type: 'number',
            description: 'Hard wall-clock limit (ms; host caps at 15min).',
          },
        },
      },
    },
    async (params): Promise<ToolResult> => {
      const parsed = parseCodeTaskParams(params);
      if (!parsed.ok) return { error: parsed.error };
      const input = parsed.value;
      const cfg = await ctx.config.get().catch(() => ({}) as Record<string, unknown>);
      const region =
        typeof cfg.region === 'string' && cfg.region.trim() ? cfg.region.trim() : 'cdg';
      const cfgTimeout = typeof cfg.timeoutMs === 'number' ? cfg.timeoutMs : undefined;

      const spritesToken = await resolveSecret(
        ctx,
        cfg,
        'spritesToken',
        'spritesTokenEnv',
        'SPRITES_TOKEN',
      );
      if (!spritesToken)
        return { error: 'Fly Sprites token unavailable in the worker env (SPRITES_TOKEN).' };
      // code_task needs to PUSH: the App installation token carries the App's contents
      // + PR permissions, so it serves this path too; PATs remain the fallback.
      const githubToken = await resolveGitHubCredential(
        async () =>
          (await resolveSecret(
            ctx,
            cfg,
            'githubPushToken',
            'githubPushTokenEnv',
            'SANDBOX_GITHUB_PUSH_TOKEN',
          )) ??
          (await resolveSecret(ctx, cfg, 'githubToken', 'githubTokenEnv', 'SANDBOX_GITHUB_TOKEN')),
        ctx.logger,
      );
      if (!githubToken)
        return {
          error:
            'Push-capable GitHub credential unavailable: no GitHub App in the worker env (GITHUB_APP_ID / GITHUB_APP_INSTALLATION_ID / GITHUB_APP_PRIVATE_KEY) and no SANDBOX_GITHUB_PUSH_TOKEN / SANDBOX_GITHUB_TOKEN — required to push.',
        };
      const anthropicKey = await resolveSecret(
        ctx,
        cfg,
        'anthropicKey',
        'anthropicKeyEnv',
        'ANTHROPIC_API_KEY',
      );
      if (!anthropicKey) return { error: 'ANTHROPIC_API_KEY unavailable in the worker env.' };

      const client = flyClient(spritesToken);
      const name = spriteNameForKey(input.sandboxKey);
      try {
        const sprite = await ensureSprite(client, name, region);
        await touchSandbox(ctx, name);
        const r = await sandboxCodeTask(sprite, {
          repoUrl: input.repoUrl,
          baseBranch: input.baseBranch,
          targetBranch: input.targetBranch,
          task: input.task,
          githubToken,
          anthropicKey,
          model: input.model,
          timeoutMs: input.timeoutMs ?? cfgTimeout,
        });
        const content = r.timedOut
          ? `Claude run timed out in sandbox "${name}" on ${r.branch}.`
          : `${r.pushed ? 'Pushed' : 'No changes pushed'} to ${r.branch} (${r.headSha?.slice(0, 12) ?? '?'}) in sandbox "${name}".`;
        return { content, data: { sandboxKey: input.sandboxKey, spriteName: name, ...r } };
      } catch (error) {
        return {
          error: `sandbox_code_task failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  );

  ctx.tools.register(
    'sandbox_release',
    {
      displayName: 'Release (delete) a sandbox',
      description:
        'Delete the Fly Sprite for a `sandboxKey` (and anything running in it). Call when the work is done; the durable result is the pushed branch/PR, so this loses nothing.',
      parametersSchema: {
        type: 'object',
        required: ['sandboxKey'],
        additionalProperties: false,
        properties: {
          sandboxKey: {
            type: 'string',
            description: 'The sandbox to release (same key used to run it).',
          },
        },
      },
    },
    async (params): Promise<ToolResult> => {
      const key =
        typeof (params as Record<string, unknown>)?.sandboxKey === 'string'
          ? ((params as Record<string, unknown>).sandboxKey as string).trim()
          : '';
      if (!key) return { error: 'Missing or empty required parameter: sandboxKey' };
      const cfg = await ctx.config.get().catch(() => ({}) as Record<string, unknown>);
      const spritesToken = await resolveSecret(
        ctx,
        cfg,
        'spritesToken',
        'spritesTokenEnv',
        'SPRITES_TOKEN',
      );
      if (!spritesToken)
        return { error: 'Fly Sprites token unavailable in the worker env (SPRITES_TOKEN).' };
      const name = spriteNameForKey(key);
      try {
        await flyClient(spritesToken).deleteSprite(name);
        await forgetSandbox(ctx, name);
        return {
          content: `Released sandbox "${name}".`,
          data: { sandboxKey: key, spriteName: name, released: true },
        };
      } catch (error) {
        return {
          error: `sandbox_release failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  );

  // Idle reaper: backstop to sandbox_release, bounds cold-storage cost.
  ctx.jobs.register('sandbox-reaper', async () => {
    const cfg = await ctx.config.get().catch(() => ({}) as Record<string, unknown>);
    const ttlDays =
      typeof cfg.reaperTtlDays === 'number' && cfg.reaperTtlDays > 0 ? cfg.reaperTtlDays : 7;
    const spritesToken = await resolveSecret(
      ctx,
      cfg,
      'spritesToken',
      'spritesTokenEnv',
      'SPRITES_TOKEN',
    );
    if (!spritesToken) {
      ctx.logger.warn('sandbox-reaper: SPRITES_TOKEN unavailable, skipping');
      return;
    }
    const res = await reapIdleSandboxes(ctx, { ttlDays, spritesToken, now: Date.now() });
    ctx.logger.info('sandbox-reaper: reclaimed idle sandboxes', { ...res, ttlDays });
  });

  // PR-review digest: weekday-morning summary of open PRs awaiting review → Google Chat.
  // A digest that cannot do its job must say so — on Chat AND in the logs. It used to
  // swallow per-repo errors and still post "aucune PR en attente", which is how a dead
  // GitHub token went unnoticed for weeks.
  ctx.jobs.register('pr-review-digest', async () => {
    const cfg = await ctx.config.get().catch(() => ({}) as Record<string, unknown>);
    // Reads GitHub as the App when it is configured — the read PAT this used to depend
    // on expired silently and took the digest with it.
    const token = await resolveGitHubCredential(
      async () =>
        (await resolveSecret(
          ctx,
          cfg,
          'githubReadToken',
          'githubReadTokenEnv',
          'SANDBOX_GITHUB_READ_TOKEN',
        )) ??
        (await resolveSecret(ctx, cfg, 'githubToken', 'githubTokenEnv', 'SANDBOX_GITHUB_TOKEN')),
      ctx.logger,
    );
    if (!token) {
      ctx.logger.error(`${JOB_FAILURE_MARKER} pr-review-digest: no GitHub credential`, {
        expected:
          'a GitHub App (GITHUB_APP_ID / GITHUB_APP_INSTALLATION_ID / GITHUB_APP_PRIVATE_KEY) or SANDBOX_GITHUB_READ_TOKEN / SANDBOX_GITHUB_TOKEN',
      });
      await emitChatNotify(
        "🚨 Digest PR indisponible : aucun identifiant GitHub n'est configuré. Le statut des revues est INCONNU.",
        'general',
        process.env,
      );
      return;
    }
    const rbacPath = (process.env.GS_RBAC_PATH || '/opt/gs-agent-tools/rbac.json').trim();
    const res = await runPrReviewDigest({ rbacPath, token, env: process.env, logger: ctx.logger });
    if (res.failed.length > 0) {
      ctx.logger.error(
        `${JOB_FAILURE_MARKER} pr-review-digest: ${res.failed.length} source(s) unreachable`,
        { ...res },
      );
      return;
    }
    ctx.logger.info('pr-review-digest: posted', { ...res });
  });
}
