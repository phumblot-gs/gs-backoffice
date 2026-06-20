import { randomUUID } from 'node:crypto';
import WebSocketImpl from 'ws';
import { definePlugin } from '@paperclipai/plugin-sdk';
import type {
  PluginEnvironmentAcquireLeaseParams,
  PluginEnvironmentDestroyLeaseParams,
  PluginEnvironmentExecuteParams,
  PluginEnvironmentExecuteResult,
  PluginEnvironmentLease,
  PluginEnvironmentProbeParams,
  PluginEnvironmentProbeResult,
  PluginEnvironmentRealizeWorkspaceParams,
  PluginEnvironmentRealizeWorkspaceResult,
  PluginEnvironmentReleaseLeaseParams,
  PluginEnvironmentResumeLeaseParams,
  PluginEnvironmentValidateConfigParams,
  PluginEnvironmentValidationResult,
} from '@paperclipai/plugin-sdk';
import { SpritesClient, Sprite } from '@fly/sprites';
import { parseDriverConfig, resolveApiKey, type SpriteDriverConfig } from './config.js';
import { buildLoginShellScript, shellQuote, isValidShellEnvKey } from './shell.js';

// The Sprites SDK uses the global WebSocket (native on Node 22, which the Paperclip
// runtime uses). Polyfill from `ws` defensively so the provider also works if the
// worker runs on an older Node.
const g = globalThis as { WebSocket?: unknown };
if (!g.WebSocket) g.WebSocket = WebSocketImpl;

const DEFAULT_REMOTE_CWD = '/home/paperclip-workspace';

function clientFor(config: SpriteDriverConfig): SpritesClient {
  return new SpritesClient(resolveApiKey(config), { timeout: 60_000 });
}

function spriteName(): string {
  return `paperclip-${randomUUID()}`;
}

interface ExecOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface RunScriptOptions {
  /** Data piped to the command's stdin. Paperclip's agent adapters (claude_local,
   *  codex_local, …) deliver the prompt and managed-runtime file transfers this way. */
  stdin?: string;
  /** Hard wall-clock limit for the command. The process is killed on expiry. */
  timeoutMs?: number;
  /** Environment variables for the command. */
  env?: Record<string, string>;
}

/**
 * Run a shell script in the Sprite via `sh -c`.
 *
 * Uses `spawn` (not `execFile`) so we can forward stdin and signal EOF: the SDK's
 * `execFile` opens the stdin channel but never closes it, so a process that reads
 * stdin (e.g. `claude -p` reading its prompt) hangs waiting for input that never
 * arrives, then the run dies as `process_lost`. We always send StdinEOF — writing
 * the caller's `stdin` first when present — and resolve with the captured exit code
 * and streams rather than throwing on a non-zero exit (mirrors child_process).
 */
export function runScript(
  sprite: Sprite,
  script: string,
  options: RunScriptOptions = {},
): Promise<ExecOutcome> {
  return new Promise<ExecOutcome>((resolve, reject) => {
    const cmd = sprite.spawn('sh', ['-c', script], options.env ? { env: options.env } : {});
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    cmd.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    cmd.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));

    cmd.once('spawn', () => {
      if (options.stdin) cmd.stdin.write(options.stdin);
      cmd.stdin.end();
      if (options.timeoutMs && options.timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          cmd.kill();
        }, options.timeoutMs);
      }
    });

    cmd.on('exit', (code: number) => {
      if (timer) clearTimeout(timer);
      resolve({
        exitCode: timedOut ? null : code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timedOut,
      });
    });

    cmd.on('error', (error: Error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
  });
}

// The Sprites exec WebSocket intermittently truncates a single command's stdout
// above ~64KB (verified on Node 20 and Node 22 native WebSocket). To transfer
// arbitrary-size output reliably we never read it in one shot: the command's
// stdout/stderr are redirected to temp files in the sandbox, then read back in
// bounded, length-verified chunks (retried on a short read).
const READBACK_CHUNK_BYTES = 32_768;
const READBACK_MAX_ATTEMPTS = 5;

/**
 * Read a remote file back in length-verified base64 chunks. Each chunk's decoded
 * length must equal the requested slice length; a short read (the SDK truncation
 * bug) is retried. Returns the exact bytes.
 */
export async function readRemoteFile(sprite: Sprite, path: string, size: number): Promise<Buffer> {
  if (size <= 0) return Buffer.alloc(0);
  const parts: Buffer[] = [];
  for (let offset = 0; offset < size; offset += READBACK_CHUNK_BYTES) {
    const length = Math.min(READBACK_CHUNK_BYTES, size - offset);
    let chunk: Buffer | null = null;
    for (let attempt = 0; attempt < READBACK_MAX_ATTEMPTS && !chunk; attempt += 1) {
      const r = await runScript(
        sprite,
        `tail -c +${offset + 1} ${shellQuote(path)} | head -c ${length} | base64`,
      );
      const decoded = Buffer.from(r.stdout.replace(/\s+/g, ''), 'base64');
      if (decoded.length === length) chunk = decoded;
    }
    if (!chunk) {
      throw new Error(
        `Failed to read ${length} bytes at offset ${offset} of ${path} after ${READBACK_MAX_ATTEMPTS} attempts`,
      );
    }
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}

/**
 * Build the shell script that runs the caller's command with stdout/stderr
 * redirected to temp files, then prints a single tiny, reliable marker line:
 * `PCX <exitCode> <stdoutBytes> <stderrBytes>`. Mirrors buildLoginShellScript's
 * profile sourcing so the command sees an interactive-shell PATH; the `cd` is
 * tolerant so an absolute-path command still runs if the dir is absent.
 */
export function buildReliableExecScript(input: {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  outPath: string;
  errPath: string;
}): string {
  const env = input.env ?? {};
  for (const key of Object.keys(env)) {
    if (!isValidShellEnvKey(key)) {
      throw new Error(`Invalid sandbox environment variable key: ${key}`);
    }
  }
  const envArgs = Object.entries(env)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([key, value]) => `${key}=${shellQuote(value)}`);
  const commandParts = [shellQuote(input.command), ...(input.args ?? []).map(shellQuote)].join(' ');
  const runLine = `${envArgs.length > 0 ? `env ${envArgs.join(' ')} ` : ''}${commandParts}`;
  const out = shellQuote(input.outPath);
  const err = shellQuote(input.errPath);
  const lines = [
    'if [ -f /etc/profile ]; then . /etc/profile >/dev/null 2>&1 || true; fi',
    'if [ -f "$HOME/.profile" ]; then . "$HOME/.profile" >/dev/null 2>&1 || true; fi',
    'if [ -f "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile" >/dev/null 2>&1 || true; elif [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc" >/dev/null 2>&1 || true; fi',
    'export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"',
    '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true',
  ];
  if (input.cwd) {
    lines.push(`cd ${shellQuote(input.cwd)} 2>/dev/null || true`);
  }
  lines.push(
    `${runLine} > ${out} 2> ${err}; __pcx_code=$?; ` +
      `printf 'PCX %s %s %s' "$__pcx_code" "$(wc -c < ${out} | tr -d ' ')" "$(wc -c < ${err} | tr -d ' ')"`,
  );
  return lines.join('\n');
}

function leaseMetadata(input: {
  config: SpriteDriverConfig;
  name: string;
  remoteCwd: string;
  resumed: boolean;
}): Record<string, unknown> {
  return {
    provider: 'fly-sprites',
    shellCommand: 'bash',
    region: input.config.region,
    reuseLease: input.config.reuseLease,
    spriteName: input.name,
    remoteCwd: input.remoteCwd,
    resumedLease: input.resumed,
  };
}

async function ensureWorkspace(sprite: Sprite, remoteCwd: string): Promise<void> {
  await runScript(sprite, buildLoginShellScript({ command: 'mkdir', args: ['-p', remoteCwd] }));
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info('Fly Sprites sandbox provider plugin ready');
  },

  async onHealth() {
    return { status: 'ok', message: 'Fly Sprites sandbox provider plugin healthy' };
  },

  async onEnvironmentValidateConfig(
    params: PluginEnvironmentValidateConfigParams,
  ): Promise<PluginEnvironmentValidationResult> {
    const config = parseDriverConfig(params.config);
    const errors: string[] = [];
    if (config.timeoutMs < 1 || config.timeoutMs > 86_400_000) {
      errors.push('timeoutMs must be between 1 and 86400000.');
    }
    if (!config.region) {
      errors.push("A Fly region is required (e.g. 'cdg').");
    }
    if (errors.length > 0) return { ok: false, errors };
    return { ok: true, normalizedConfig: { ...config } };
  },

  async onEnvironmentProbe(
    params: PluginEnvironmentProbeParams,
  ): Promise<PluginEnvironmentProbeResult> {
    const config = parseDriverConfig(params.config);
    const client = clientFor(config);
    const name = spriteName();
    try {
      const sprite = await client.createSprite(name, { region: config.region });
      const result = await runScript(sprite, buildLoginShellScript({ command: 'pwd' }));
      return {
        ok: result.exitCode === 0,
        summary:
          result.exitCode === 0
            ? `Provisioned a Fly Sprite in ${config.region} and ran a command.`
            : `Provisioned a Fly Sprite in ${config.region} but the probe command failed (exit ${result.exitCode}).`,
        metadata: {
          provider: 'fly-sprites',
          region: config.region,
          stderr: result.stderr.slice(0, 500),
        },
      };
    } catch (error) {
      return {
        ok: false,
        summary: `Fly Sprite probe failed in ${config.region}.`,
        metadata: {
          provider: 'fly-sprites',
          region: config.region,
          error: error instanceof Error ? error.message : String(error),
        },
      };
    } finally {
      await client.deleteSprite(name).catch(() => undefined);
    }
  },

  async onEnvironmentAcquireLease(
    params: PluginEnvironmentAcquireLeaseParams,
  ): Promise<PluginEnvironmentLease> {
    const config = parseDriverConfig(params.config);
    const client = clientFor(config);
    const name = spriteName();
    try {
      const sprite = await client.createSprite(name, { region: config.region });
      const remoteCwd = DEFAULT_REMOTE_CWD;
      await ensureWorkspace(sprite, remoteCwd);
      return {
        providerLeaseId: name,
        metadata: leaseMetadata({ config, name, remoteCwd, resumed: false }),
      };
    } catch (error) {
      await client.deleteSprite(name).catch(() => undefined);
      throw error;
    }
  },

  async onEnvironmentResumeLease(
    params: PluginEnvironmentResumeLeaseParams,
  ): Promise<PluginEnvironmentLease> {
    if (!params.providerLeaseId) return { providerLeaseId: null, metadata: { expired: true } };
    const config = parseDriverConfig(params.config);
    const client = clientFor(config);
    let sprite: Sprite;
    try {
      sprite = await client.getSprite(params.providerLeaseId);
    } catch {
      return { providerLeaseId: null, metadata: { expired: true } };
    }
    const remoteCwd = DEFAULT_REMOTE_CWD;
    await ensureWorkspace(sprite, remoteCwd);
    return {
      providerLeaseId: params.providerLeaseId,
      metadata: leaseMetadata({ config, name: params.providerLeaseId, remoteCwd, resumed: true }),
    };
  },

  async onEnvironmentReleaseLease(params: PluginEnvironmentReleaseLeaseParams): Promise<void> {
    if (!params.providerLeaseId) return;
    const config = parseDriverConfig(params.config);
    // Reuse: leave the Sprite to hibernate (0 idle cost, instant wake on resume).
    if (config.reuseLease) return;
    await clientFor(config)
      .deleteSprite(params.providerLeaseId)
      .catch(() => undefined);
  },

  async onEnvironmentDestroyLease(params: PluginEnvironmentDestroyLeaseParams): Promise<void> {
    if (!params.providerLeaseId) return;
    const config = parseDriverConfig(params.config);
    await clientFor(config)
      .deleteSprite(params.providerLeaseId)
      .catch(() => undefined);
  },

  async onEnvironmentRealizeWorkspace(
    params: PluginEnvironmentRealizeWorkspaceParams,
  ): Promise<PluginEnvironmentRealizeWorkspaceResult> {
    const config = parseDriverConfig(params.config);
    const remoteCwd =
      (typeof params.lease.metadata?.remoteCwd === 'string' && params.lease.metadata.remoteCwd) ||
      params.workspace.remotePath ||
      params.workspace.localPath ||
      DEFAULT_REMOTE_CWD;
    if (params.lease.providerLeaseId) {
      const sprite = clientFor(config).sprite(params.lease.providerLeaseId);
      await ensureWorkspace(sprite, remoteCwd);
    }
    return { cwd: remoteCwd, metadata: { provider: 'fly-sprites', remoteCwd } };
  },

  async onEnvironmentExecute(
    params: PluginEnvironmentExecuteParams,
  ): Promise<PluginEnvironmentExecuteResult> {
    if (!params.lease.providerLeaseId) {
      return {
        exitCode: 1,
        timedOut: false,
        stdout: '',
        stderr: 'No provider lease ID for execution.',
      };
    }
    const config = parseDriverConfig(params.config);
    const sprite = clientFor(config).sprite(params.lease.providerLeaseId);
    // Redirect the command's output to temp files, then read them back in
    // length-verified chunks. This is the only reliable way to transfer
    // arbitrary-size output given the Sprites exec WebSocket truncation bug —
    // notably Paperclip's workspace restore, which reads a whole tar as one
    // `base64 < file`. The marker line itself is tiny and always fits one frame.
    const id = randomUUID();
    const outPath = `/tmp/.pcx-${id}.out`;
    const errPath = `/tmp/.pcx-${id}.err`;
    const cleanup = () =>
      runScript(sprite, `rm -f ${shellQuote(outPath)} ${shellQuote(errPath)}`).catch(
        () => undefined,
      );
    try {
      const meta = await runScript(
        sprite,
        buildReliableExecScript({
          command: params.command,
          args: params.args ?? [],
          env: params.env,
          cwd: params.cwd,
          outPath,
          errPath,
        }),
        { stdin: params.stdin, timeoutMs: params.timeoutMs },
      );
      if (meta.timedOut) {
        await cleanup();
        return { exitCode: null, timedOut: true, stdout: '', stderr: '' };
      }
      const marker = meta.stdout.match(/PCX (-?\d+) (\d+) (\d+)/);
      if (!marker) {
        await cleanup();
        return {
          exitCode: 1,
          timedOut: false,
          stdout: '',
          stderr:
            `Fly Sprites execution produced no result marker. ` +
            `stdout=${JSON.stringify(meta.stdout.slice(0, 200))} stderr=${JSON.stringify(meta.stderr.slice(0, 200))}`,
        };
      }
      const [, exitCode, stdoutBytes, stderrBytes] = marker;
      const stdout = await readRemoteFile(sprite, outPath, Number(stdoutBytes));
      const stderr = await readRemoteFile(sprite, errPath, Number(stderrBytes));
      await cleanup();
      return {
        exitCode: Number(exitCode),
        timedOut: false,
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'),
      };
    } catch (error) {
      // A dropped WebSocket / transport error becomes a failed command rather
      // than a thrown transport crash, so Paperclip can record and retry it.
      await cleanup();
      return {
        exitCode: 1,
        timedOut: false,
        stdout: '',
        stderr: `Fly Sprites execution failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
});

export default plugin;
