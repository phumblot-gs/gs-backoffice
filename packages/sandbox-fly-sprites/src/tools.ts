import type { PluginContext, ToolResult } from '@paperclipai/plugin-sdk';
import { flyClient } from './exec.js';
import { sandboxRun } from './sandbox.js';

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

/** Resolve a secret by the configured reference name (operator config → secret value). */
async function resolveRef(
  ctx: PluginContext,
  cfg: Record<string, unknown>,
  key: string,
  fallbackRef: string,
): Promise<string | undefined> {
  const ref =
    typeof cfg[key] === 'string' && (cfg[key] as string).trim()
      ? (cfg[key] as string).trim()
      : fallbackRef;
  if (!ref) return undefined;
  try {
    const value = await ctx.secrets.resolve(ref);
    return value && value.trim() ? value : undefined;
  } catch {
    return undefined;
  }
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

      const spritesToken = await resolveRef(ctx, cfg, 'spritesTokenRef', 'SPRITES_TOKEN');
      if (!spritesToken) {
        return {
          error: 'Fly Sprites token not configured (set spritesTokenRef to a secret name).',
        };
      }
      const githubToken = await resolveRef(
        ctx,
        cfg,
        input.credMode === 'push' ? 'githubPushTokenRef' : 'githubReadTokenRef',
        '',
      );

      const client = flyClient(spritesToken);
      const name = spriteNameForKey(input.sandboxKey);
      let sprite;
      try {
        sprite = await client.getSprite(name);
      } catch {
        sprite = await client.createSprite(name, { region });
      }

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
}
