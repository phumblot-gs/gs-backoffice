import { randomUUID } from 'node:crypto';
import type { Sprite } from '@fly/sprites';
import { execReliable, type ExecOutcome } from './exec.js';
import { shellQuote } from './shell.js';

/** Default working directory for the cloned repo inside the Sprite (user `sprite`). */
export const SANDBOX_WORK_DIR = '/home/sprite/work';

/**
 * Shell to configure git auth + identity. The token is read from `$GH_TOKEN` at
 * call time via a credential helper, so it is never written to `.git/config` or a
 * remote URL. Pure (testable); the caller passes `$GH_TOKEN` in the command env.
 */
export function buildGitCredentialSetup(): string {
  return (
    `git config --global credential.helper ` +
    `'!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f'; ` +
    `git config --global user.email sandbox@grandshooting.dev; ` +
    `git config --global user.name 'gs-sandbox'`
  );
}

/**
 * Shell that brings the repo to `ref` in `workDir`:
 *  - reuse the existing clone iff its `origin` matches `repoUrl` (repo-match guard,
 *    since repoUrl is per-project and can change) — otherwise re-clone fresh;
 *  - fetch, then check out `ref` (a branch name DWIMs from origin; a commit SHA
 *    detaches). Pure (testable).
 */
export function buildCheckoutScript(input: {
  repoUrl: string;
  ref: string;
  workDir: string;
}): string {
  const work = shellQuote(input.workDir);
  const url = shellQuote(input.repoUrl);
  const ref = shellQuote(input.ref);
  return [
    buildGitCredentialSetup(),
    `if [ "$(cd ${work} 2>/dev/null && git remote get-url origin 2>/dev/null)" = ${url} ]; then`,
    `  cd ${work} && git fetch origin --prune --tags;`,
    `else`,
    `  rm -rf ${work} && git clone ${url} ${work} && cd ${work};`,
    `fi`,
    `cd ${work} && git fetch origin ${ref} 2>/dev/null || true`,
    `cd ${work} && (git checkout --quiet ${ref} || git checkout --quiet -B ${ref} origin/${ref})`,
  ].join('\n');
}

export interface SandboxRunInput {
  repoUrl: string;
  /** Branch name or commit SHA to check out. */
  ref: string;
  /** Command to run in the repo dir (interpreted by `sh -c`). */
  command: string;
  /** GitHub token for clone/fetch (scoped read-only or push by the caller). */
  githubToken?: string;
  /** Extra env for the command (e.g. ANTHROPIC_API_KEY for a Claude run). */
  env?: Record<string, string>;
  timeoutMs?: number;
  workDir?: string;
}

export interface SandboxRunResult {
  ref: string;
  checkedOutSha: string | null;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Bring the repo to `ref` in the Sprite, then run `command` in the repo dir and
 * capture the result via the reliable transport. Does NOT push — `sandbox_run` is
 * for verification/inspection (scanners, tests); pushing is `sandbox_code_task`.
 */
export async function sandboxRun(
  sprite: Sprite,
  input: SandboxRunInput,
): Promise<SandboxRunResult> {
  const workDir = input.workDir ?? SANDBOX_WORK_DIR;
  const gitEnv = input.githubToken ? { GH_TOKEN: input.githubToken } : undefined;

  const checkout = await execReliable(sprite, {
    command: 'sh',
    args: ['-c', buildCheckoutScript({ repoUrl: input.repoUrl, ref: input.ref, workDir })],
    env: gitEnv,
    timeoutMs: input.timeoutMs ?? 180_000,
    id: randomUUID(),
  });
  if (checkout.exitCode !== 0) {
    return {
      ref: input.ref,
      checkedOutSha: null,
      exitCode: checkout.exitCode,
      stdout: '',
      stderr: `Failed to prepare repo at ${input.ref}: ${checkout.stderr.slice(0, 500)}`,
      timedOut: checkout.timedOut,
    };
  }

  const run = await execReliable(sprite, {
    command: 'sh',
    args: ['-c', `cd ${shellQuote(workDir)} && ${input.command}`],
    env: input.env,
    timeoutMs: input.timeoutMs,
    id: randomUUID(),
  });

  let checkedOutSha: string | null = null;
  const sha: ExecOutcome = await execReliable(sprite, {
    command: 'sh',
    args: ['-c', `cd ${shellQuote(workDir)} && git rev-parse HEAD`],
    id: randomUUID(),
  });
  if (sha.exitCode === 0) checkedOutSha = sha.stdout.trim() || null;

  return {
    ref: input.ref,
    checkedOutSha,
    exitCode: run.exitCode,
    stdout: run.stdout,
    stderr: run.stderr,
    timedOut: run.timedOut,
  };
}
