import { describe, it, expect } from 'vitest';
import { SpritesClient } from './sprites-client.js';

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fake fetch that records the request and returns a canned response. */
function fakeFetch(
  captured: Captured[],
  response: { status?: number; json?: unknown; text?: string },
): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    captured.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: (init?.headers as Record<string, string>) ?? {},
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return {
      ok: (response.status ?? 200) < 400,
      status: response.status ?? 200,
      json: async () => response.json ?? {},
      text: async () => response.text ?? '',
    } as Response;
  }) as unknown as typeof fetch;
}

const client = (cap: Captured[], resp = {}) =>
  new SpritesClient({ token: 'acme/tok', fetchImpl: fakeFetch(cap, resp) });

describe('SpritesClient', () => {
  it('creates a sprite with auth header + region/image in body', async () => {
    const cap: Captured[] = [];
    await client(cap).createSprite('paperclip-1', { image: 'node:22', region: 'cdg' });
    expect(cap[0].url).toBe('https://api.sprites.dev/v1/sprites');
    expect(cap[0].method).toBe('POST');
    expect(cap[0].headers.Authorization).toBe('Bearer acme/tok');
    expect(cap[0].body).toEqual({ name: 'paperclip-1', image: 'node:22', region: 'cdg' });
  });

  it('execs by posting the command and parses the result', async () => {
    const cap: Captured[] = [];
    const res = await client(cap, {
      json: { exitCode: 0, stdout: 'ok', stderr: '', timedOut: false },
    }).exec('s1', 'pwd', 1000);
    expect(cap[0].url).toBe('https://api.sprites.dev/v1/sprites/s1/exec');
    expect(cap[0].body).toEqual({ cmd: 'pwd', timeoutMs: 1000 });
    expect(res).toEqual({ exitCode: 0, stdout: 'ok', stderr: '', timedOut: false });
  });

  it('tolerates a missing exitCode in the exec response', async () => {
    const cap: Captured[] = [];
    const res = await client(cap, { json: {} }).exec('s1', 'x');
    expect(res.exitCode).toBeNull();
    expect(res.stdout).toBe('');
  });

  it('getSprite returns null on 404', async () => {
    const cap: Captured[] = [];
    expect(await client(cap, { status: 404 }).getSprite('gone')).toBeNull();
  });

  it('writeFile posts to an encoded filesystem path', async () => {
    const cap: Captured[] = [];
    await client(cap).writeFile('s1', 'dir/file.txt', 'hello');
    expect(cap[0].url).toBe('https://api.sprites.dev/v1/sprites/s1/filesystem/dir/file.txt');
    expect(cap[0].method).toBe('POST');
    expect(cap[0].body).toEqual({ content: 'hello' });
  });

  it('throws on non-404 errors', async () => {
    const cap: Captured[] = [];
    await expect(client(cap, { status: 500, text: 'boom' }).destroySprite('s1')).rejects.toThrow(
      /→ 500/,
    );
  });
});
