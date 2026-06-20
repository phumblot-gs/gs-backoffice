import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { runScript } from './plugin.js';
import type { Sprite } from '@fly/sprites';

/**
 * Minimal fake of the SDK's SpriteCommand: an EventEmitter exposing stdin
 * (capturing what gets written + whether EOF was sent) and stdout/stderr.
 */
function fakeCommand() {
  const cmd = new EventEmitter() as EventEmitter & {
    stdin: PassThrough & { ended?: boolean };
    stdout: PassThrough;
    stderr: PassThrough;
    kill: () => void;
    killed: boolean;
  };
  cmd.stdin = new PassThrough();
  cmd.stdout = new PassThrough();
  cmd.stderr = new PassThrough();
  cmd.killed = false;
  const origEnd = cmd.stdin.end.bind(cmd.stdin);
  cmd.stdin.end = ((...a: unknown[]) => {
    cmd.stdin.ended = true;
    return origEnd(...(a as []));
  }) as typeof cmd.stdin.end;
  cmd.kill = () => {
    cmd.killed = true;
  };
  return cmd;
}

function fakeSprite(cmd: ReturnType<typeof fakeCommand>) {
  return {
    spawn: () => {
      // Emit 'spawn' on next tick like the real SDK, then the caller wires stdin.
      process.nextTick(() => cmd.emit('spawn'));
      return cmd;
    },
  } as unknown as Sprite;
}

describe('runScript', () => {
  it('forwards stdin and always sends EOF, returns captured output + exit code', async () => {
    const cmd = fakeCommand();
    const received: string[] = [];
    cmd.stdin.on('data', (c) => received.push(c.toString()));

    const p = runScript(fakeSprite(cmd), 'cat', { stdin: 'the-prompt' });
    // After 'spawn' + stdin handling, emit output then exit.
    await new Promise((r) => setImmediate(r));
    cmd.stdout.emit('data', Buffer.from('done'));
    cmd.emit('exit', 0);

    const out = await p;
    expect(received.join('')).toBe('the-prompt');
    expect(cmd.stdin.ended).toBe(true);
    expect(out).toEqual({ exitCode: 0, stdout: 'done', stderr: '', timedOut: false });
  });

  it('sends EOF even when no stdin is provided', async () => {
    const cmd = fakeCommand();
    const p = runScript(fakeSprite(cmd), 'pwd');
    await new Promise((r) => setImmediate(r));
    cmd.emit('exit', 0);
    await p;
    expect(cmd.stdin.ended).toBe(true);
  });

  it('kills the command and reports timedOut on timeout expiry', async () => {
    vi.useFakeTimers();
    try {
      const cmd = fakeCommand();
      const p = runScript(fakeSprite(cmd), 'sleep 999', { timeoutMs: 1000 });
      await vi.advanceTimersByTimeAsync(1); // let 'spawn' fire + timer arm
      expect(cmd.killed).toBe(false);
      await vi.advanceTimersByTimeAsync(1000); // expire
      expect(cmd.killed).toBe(true);
      cmd.emit('exit', 143); // process dies after kill
      const out = await p;
      expect(out.timedOut).toBe(true);
      expect(out.exitCode).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects on a transport error (dropped connection)', async () => {
    const cmd = fakeCommand();
    const p = runScript(fakeSprite(cmd), 'cat');
    await new Promise((r) => setImmediate(r));
    cmd.emit('error', new Error('socket hang up'));
    await expect(p).rejects.toThrow('socket hang up');
  });
});
