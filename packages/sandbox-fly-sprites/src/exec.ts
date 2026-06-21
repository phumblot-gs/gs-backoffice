import WebSocketImpl from 'ws';
import { SpritesClient, type Sprite } from '@fly/sprites';
import { shellQuote, isValidShellEnvKey } from './shell.js';

// The Sprites SDK uses the global WebSocket (native on Node 22, which the Paperclip
// runtime uses). Polyfill from `ws` defensively so the provider also works if the
// worker runs on an older Node.
const g = globalThis as { WebSocket?: unknown };
if (!g.WebSocket) g.WebSocket = WebSocketImpl;

/** Create a Fly Sprites client. `timeoutMs` is the SDK's HTTP timeout, not an exec limit. */
export function flyClient(token: string, timeoutMs = 60_000): SpritesClient {
  return new SpritesClient(token, { timeout: timeoutMs });
}

export interface ExecOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunScriptOptions {
  /** Data piped to the command's stdin (e.g. an agent prompt or a file-transfer body). */
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
 * `execFile` opens the stdin channel but never sends EOF, so a process that reads
 * stdin (e.g. `claude -p` reading its prompt) hangs. We always send StdinEOF —
 * writing the caller's `stdin` first when present — and resolve with the captured
 * exit code and streams rather than throwing on a non-zero exit (mirrors
 * child_process). Resolution waits for both streams to end, not just `exit`.
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
 * `PCX <exitCode> <stdoutBytes> <stderrBytes>`. Sources login profiles so the
 * command sees an interactive-shell PATH; the `cd` is tolerant so an absolute-path
 * command still runs if the dir is absent.
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

/**
 * Reliable command execution: redirect the command's output to temp files, parse
 * a tiny marker, then read each file back in length-verified chunks. This is the
 * only way to transfer arbitrary-size output given the Sprites exec WS truncation.
 * Returns the full stdout/stderr (utf8), exit code, and `timedOut`.
 */
export async function execReliable(
  sprite: Sprite,
  input: {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    stdin?: string;
    timeoutMs?: number;
    id: string;
  },
): Promise<ExecOutcome> {
  const outPath = `/tmp/.pcx-${input.id}.out`;
  const errPath = `/tmp/.pcx-${input.id}.err`;
  const cleanup = () =>
    runScript(sprite, `rm -f ${shellQuote(outPath)} ${shellQuote(errPath)}`).catch(() => undefined);
  try {
    const meta = await runScript(
      sprite,
      buildReliableExecScript({
        command: input.command,
        args: input.args ?? [],
        env: input.env,
        cwd: input.cwd,
        outPath,
        errPath,
      }),
      { stdin: input.stdin, timeoutMs: input.timeoutMs },
    );
    if (meta.timedOut) {
      await cleanup();
      return { exitCode: null, stdout: '', stderr: '', timedOut: true };
    }
    const marker = meta.stdout.match(/PCX (-?\d+) (\d+) (\d+)/);
    if (!marker) {
      await cleanup();
      return {
        exitCode: 1,
        stdout: '',
        stderr: `Fly Sprites execution produced no result marker. stdout=${JSON.stringify(meta.stdout.slice(0, 200))} stderr=${JSON.stringify(meta.stderr.slice(0, 200))}`,
        timedOut: false,
      };
    }
    const [, exitCode, stdoutBytes, stderrBytes] = marker;
    const stdout = await readRemoteFile(sprite, outPath, Number(stdoutBytes));
    const stderr = await readRemoteFile(sprite, errPath, Number(stderrBytes));
    await cleanup();
    return {
      exitCode: Number(exitCode),
      stdout: stdout.toString('utf8'),
      stderr: stderr.toString('utf8'),
      timedOut: false,
    };
  } catch (error) {
    await cleanup();
    return {
      exitCode: 1,
      stdout: '',
      stderr: `Fly Sprites execution failed: ${error instanceof Error ? error.message : String(error)}`,
      timedOut: false,
    };
  }
}
