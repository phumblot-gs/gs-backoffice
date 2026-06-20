import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { buildReliableExecScript, readRemoteFile } from './plugin.js';
import type { Sprite } from '@fly/sprites';

describe('buildReliableExecScript', () => {
  it('redirects output to the temp files and prints a PCX size marker', () => {
    const s = buildReliableExecScript({
      command: 'base64',
      args: ['/tmp/x'],
      outPath: '/tmp/.pcx-1.out',
      errPath: '/tmp/.pcx-1.err',
    });
    expect(s).toContain("> '/tmp/.pcx-1.out' 2> '/tmp/.pcx-1.err'");
    expect(s).toContain("printf 'PCX %s %s %s'");
    expect(s).toContain("wc -c < '/tmp/.pcx-1.out'");
    // profiles sourced but suppressed so they never pollute captured output
    expect(s).toContain('/etc/profile >/dev/null 2>&1');
  });

  it('interpolates env and uses a tolerant cd', () => {
    const s = buildReliableExecScript({
      command: 'sh',
      args: ['-c', 'echo hi'],
      env: { ANTHROPIC_API_KEY: 'sk-test' },
      cwd: '/work dir',
      outPath: '/tmp/o',
      errPath: '/tmp/e',
    });
    expect(s).toContain("env ANTHROPIC_API_KEY='sk-test'");
    expect(s).toContain("cd '/work dir' 2>/dev/null || true");
  });

  it('rejects invalid environment variable keys', () => {
    expect(() =>
      buildReliableExecScript({ command: 'x', env: { '1BAD': 'v' }, outPath: '/o', errPath: '/e' }),
    ).toThrow(/Invalid sandbox environment variable key/);
  });
});

/** Fake Sprite whose `spawn` serves base64 slices of `content`, parsing the
 *  `tail -c +OFF | head -c LEN | base64` script. Optionally truncates the first
 *  read of each chunk to exercise the verify+retry path. */
function fakeFileSprite(content: Buffer, opts: { truncateFirst?: boolean } = {}) {
  const seen = new Set<string>();
  return {
    spawn: (_cmd: string, args: string[]) => {
      const script = args[1];
      const m = script.match(/tail -c \+(\d+) .*head -c (\d+)/);
      const offset = Number(m![1]) - 1;
      const length = Number(m![2]);
      let slice = content.subarray(offset, offset + length);
      const key = `${offset}:${length}`;
      if (opts.truncateFirst && !seen.has(key)) {
        seen.add(key);
        slice = slice.subarray(0, Math.max(0, length - 7)); // short read once
      }
      const cmd = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: () => void };
      cmd.stdin = new PassThrough();
      cmd.stdout = new PassThrough();
      cmd.stderr = new PassThrough();
      cmd.kill = () => undefined;
      queueMicrotask(() => {
        cmd.emit('spawn');
        cmd.stdout.emit('data', Buffer.from(slice.toString('base64')));
        cmd.emit('exit', 0);
      });
      return cmd;
    },
  } as unknown as Sprite;
}

describe('readRemoteFile', () => {
  it('returns empty buffer for zero size', async () => {
    const out = await readRemoteFile(fakeFileSprite(Buffer.alloc(0)), '/f', 0);
    expect(out.length).toBe(0);
  });

  it('reassembles a multi-chunk file exactly', async () => {
    const content = Buffer.alloc(32_768 * 2 + 1234, 7);
    for (let i = 0; i < content.length; i += 1) content[i] = i % 251;
    const out = await readRemoteFile(fakeFileSprite(content), '/f', content.length);
    expect(out.equals(content)).toBe(true);
  });

  it('retries a short read and still returns correct bytes', async () => {
    const content = Buffer.alloc(5000);
    for (let i = 0; i < content.length; i += 1) content[i] = (i * 13) % 256;
    const out = await readRemoteFile(fakeFileSprite(content, { truncateFirst: true }), '/f', content.length);
    expect(out.equals(content)).toBe(true);
  });
});
