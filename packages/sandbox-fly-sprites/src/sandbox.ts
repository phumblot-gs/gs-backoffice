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

/**
 * Shell that brings the repo to `targetBranch` in `workDir`, ready for editing:
 *  - reuse-or-clone (repo-match guard, like buildCheckoutScript);
 *  - if `targetBranch` already exists on origin, continue it (preserve prior
 *    iterations); otherwise create it from `baseBranch`. Pure (testable).
 */
export function buildCodeTaskCheckoutScript(input: {
  repoUrl: string;
  baseBranch: string;
  targetBranch: string;
  workDir: string;
}): string {
  const work = shellQuote(input.workDir);
  const url = shellQuote(input.repoUrl);
  return [
    buildGitCredentialSetup(),
    `if [ "$(cd ${work} 2>/dev/null && git remote get-url origin 2>/dev/null)" = ${url} ]; then`,
    `  cd ${work} && git fetch origin --prune;`,
    `else`,
    `  rm -rf ${work} && git clone ${url} ${work} && cd ${work};`,
    `fi`,
    `cd ${work} && git fetch origin --prune`,
    // Continue the target branch if it exists on origin, else branch from base.
    `if git show-ref --verify --quiet "refs/remotes/origin/$TB"; then git checkout -B "$TB" "origin/$TB"; ` +
      `else git checkout -B "$TB" "origin/$BB" 2>/dev/null || git checkout -B "$TB"; fi`,
  ].join('\n');
}

/**
 * Best-effort formatting pass, run after Claude edits and BEFORE the commit, so pushed
 * branches are always prettier-clean and never fail CI's `format:check` step (the
 * recurring loop failure). Uses the repo's OWN prettier (CI parity) via corepack+pnpm.
 * Every step is `|| true` so an install/format hiccup never blocks the task — worst case
 * the commit is unformatted, exactly as before this step existed. Pure (testable).
 */
export function buildFormatScript(workDir: string): string {
  const work = shellQuote(workDir);
  return [
    `cd ${work} || exit 0`,
    `corepack enable >/dev/null 2>&1 || true`,
    `pnpm install --prefer-offline --silent >/dev/null 2>&1 || true`,
    `pnpm format >/dev/null 2>&1 || pnpm exec prettier --write . >/dev/null 2>&1 || true`,
  ].join('\n');
}

export interface SandboxCodeTaskInput {
  repoUrl: string;
  baseBranch: string;
  targetBranch: string;
  /** Instruction handed to `claude -p` inside the Sprite (it edits files only). */
  task: string;
  /** Push-capable GitHub token. */
  githubToken?: string;
  /** Anthropic API key for the in-sandbox Claude run. */
  anthropicKey?: string;
  model?: string;
  timeoutMs?: number;
  workDir?: string;
}

export interface SandboxCodeTaskResult {
  branch: string;
  headSha: string | null;
  pushed: boolean;
  summary: string;
  costUsd: number | null;
  claudeExitCode: number | null;
  timedOut: boolean;
  pushOutput: string;
}

/**
 * Run Claude in the Sprite to perform a coding task on `targetBranch`, then commit
 * and **push from inside the sandbox**. Claude only edits files; the tool drives
 * git (so Claude never needs the token). Mirrors the validated spike.
 */
export async function sandboxCodeTask(
  sprite: Sprite,
  input: SandboxCodeTaskInput,
): Promise<SandboxCodeTaskResult> {
  const workDir = input.workDir ?? SANDBOX_WORK_DIR;
  const gitEnv = {
    ...(input.githubToken ? { GH_TOKEN: input.githubToken } : {}),
    TB: input.targetBranch,
    BB: input.baseBranch,
  };

  const checkout = await execReliable(sprite, {
    command: 'sh',
    args: [
      '-c',
      buildCodeTaskCheckoutScript({
        repoUrl: input.repoUrl,
        baseBranch: input.baseBranch,
        targetBranch: input.targetBranch,
        workDir,
      }),
    ],
    env: gitEnv,
    timeoutMs: input.timeoutMs ?? 180_000,
    id: randomUUID(),
  });
  if (checkout.exitCode !== 0) {
    return {
      branch: input.targetBranch,
      headSha: null,
      pushed: false,
      summary: `Failed to prepare branch ${input.targetBranch}: ${checkout.stderr.slice(0, 400)}`,
      costUsd: null,
      claudeExitCode: null,
      timedOut: checkout.timedOut,
      pushOutput: '',
    };
  }

  // Claude edits files only (acceptEdits; isolated VM). No git, no token.
  const claudeArgs = [
    '-p',
    input.task,
    '--output-format',
    'json',
    '--permission-mode',
    'acceptEdits',
  ];
  if (input.model) claudeArgs.push('--model', input.model);
  const claudeCmd = `cd ${shellQuote(workDir)} && claude ${claudeArgs.map(shellQuote).join(' ')} 2>&1`;
  const claude = await execReliable(sprite, {
    command: 'sh',
    args: ['-c', claudeCmd],
    env: input.anthropicKey ? { ANTHROPIC_API_KEY: input.anthropicKey } : undefined,
    timeoutMs: input.timeoutMs,
    id: randomUUID(),
  });
  let summary = '';
  let costUsd: number | null = null;
  try {
    const j = JSON.parse(claude.stdout.slice(claude.stdout.indexOf('{')));
    summary = typeof j.result === 'string' ? j.result : '';
    costUsd = typeof j.total_cost_usd === 'number' ? j.total_cost_usd : null;
  } catch {
    summary = claude.stdout.slice(-400);
  }

  // B3: deterministic format pass before the commit, so the pushed branch is always
  // prettier-clean (CI `format:check` parity). Best-effort — its outcome is ignored, so
  // an install/format hiccup never blocks the task.
  await execReliable(sprite, {
    command: 'sh',
    args: ['-c', buildFormatScript(workDir)],
    timeoutMs: 240_000,
    id: randomUUID(),
  });

  // Commit + push from the sandbox.
  const commitMsg = `sandbox: ${input.task.slice(0, 60).replace(/\s+/g, ' ')}`;
  const pushScript =
    `cd ${shellQuote(workDir)} && git add -A && ` +
    `(git diff --cached --quiet && echo NOCHANGES || ` +
    `(git commit -q -m ${shellQuote(commitMsg)} && git push -u origin "$TB" 2>&1)); ` +
    `git rev-parse HEAD`;
  const push = await execReliable(sprite, {
    command: 'sh',
    args: ['-c', pushScript],
    env: gitEnv,
    timeoutMs: input.timeoutMs ?? 180_000,
    id: randomUUID(),
  });
  const pushOutput = push.stdout.trim();
  const headSha = pushOutput.split('\n').pop() ?? null;
  const pushed = !pushOutput.includes('NOCHANGES') && /->|new branch|up to date/.test(pushOutput);

  return {
    branch: input.targetBranch,
    headSha,
    pushed,
    summary: summary.slice(0, 600),
    costUsd,
    claudeExitCode: claude.exitCode,
    timedOut: claude.timedOut,
    pushOutput: pushOutput.slice(-300),
  };
}
