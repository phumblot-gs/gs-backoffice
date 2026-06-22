import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readRepoScopes,
  listOpenReviewPrs,
  buildDigestText,
  emitChatNotify,
  runPrReviewDigest,
  type ReviewPr,
} from './digest.js';

function rbacFile(repos?: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'rbac-'));
  const p = join(dir, 'rbac.json');
  writeFileSync(p, JSON.stringify({ companies: {}, ...(repos ? { repos } : {}) }));
  return p;
}

function fakeFetch(handler: (url: string) => { ok: boolean; status: number; body: string }) {
  return (async (url: string) => {
    const r = handler(url);
    return { ok: r.ok, status: r.status, text: async () => r.body };
  }) as never;
}

describe('readRepoScopes', () => {
  it('reads the repos map; {} on missing file', () => {
    expect(readRepoScopes(rbacFile({ 'o/r': 'general' }))).toEqual({ 'o/r': 'general' });
    expect(readRepoScopes('/no/such.json')).toEqual({});
  });
});

describe('listOpenReviewPrs', () => {
  it('returns open non-draft PRs mapped to ReviewPr', async () => {
    const f = fakeFetch(() => ({
      ok: true,
      status: 200,
      body: JSON.stringify([
        { number: 1, title: 'A', html_url: 'u1', draft: false, user: { login: 'alice' } },
        { number: 2, title: 'B (draft)', html_url: 'u2', draft: true, user: { login: 'bob' } },
      ]),
    }));
    const prs = await listOpenReviewPrs('org/repo', 'tok', f);
    expect(prs).toEqual([{ repo: 'org/repo', number: 1, title: 'A', url: 'u1', author: 'alice' }]);
  });
  it('throws on a GitHub error', async () => {
    const f = fakeFetch(() => ({ ok: false, status: 403, body: 'forbidden' }));
    await expect(listOpenReviewPrs('org/repo', 'tok', f)).rejects.toThrow(/HTTP 403/);
  });
});

describe('buildDigestText', () => {
  it('all-clear when empty, list with chat links otherwise', () => {
    expect(buildDigestText([])).toMatch(/aucune PR/);
    const prs: ReviewPr[] = [
      { repo: 'o/r', number: 7, title: 'T', url: 'http://x/7', author: 'a' },
    ];
    const t = buildDigestText(prs);
    expect(t).toContain('1 PR(s)');
    expect(t).toContain('<http://x/7|#7>');
  });
});

describe('emitChatNotify', () => {
  it('posts a notify event when EVT env is set', async () => {
    const cap: { url?: string; body?: string } = {};
    const f = (async (url: string, init: { body: string }) => {
      cap.url = url;
      cap.body = init.body;
      return { ok: true, status: 200, text: async () => '' };
    }) as never;
    const env = {
      EVT_API_URL: 'https://evt/',
      EVT_API_KEY: 'k',
      EVT_ACCOUNT_ID: '16',
    } as NodeJS.ProcessEnv;
    expect(await emitChatNotify('hello', 'general', env, f)).toBe(true);
    expect(cap.url).toBe('https://evt/v1/events');
    const body = JSON.parse(cap.body as string);
    expect(body.eventType).toBe('backoffice.notify.google_chat');
    expect(body.payload).toEqual({ text: 'hello', scope: 'general' });
  });
  it('no-ops (false) when EVT env missing', async () => {
    expect(await emitChatNotify('x', 'general', {} as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe('runPrReviewDigest', () => {
  it('gathers PRs across configured repos and emits one digest', async () => {
    const env = {
      EVT_API_URL: 'https://evt',
      EVT_API_KEY: 'k',
      EVT_ACCOUNT_ID: '16',
    } as NodeJS.ProcessEnv;
    const calls: string[] = [];
    const f = (async (url: string) => {
      calls.push(url);
      if (url.includes('/pulls')) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify([
              { number: 9, title: 'X', html_url: 'http://x/9', draft: false, user: { login: 'z' } },
            ]),
        };
      }
      return { ok: true, status: 200, text: async () => '' }; // EVT publish
    }) as never;
    const res = await runPrReviewDigest({
      rbacPath: rbacFile({ 'org/repo': 'general' }),
      token: 'tok',
      env,
      fetchImpl: f,
    });
    expect(res).toEqual({ repos: 1, prs: 1, sent: true });
    expect(calls.some((u) => u.includes('/repos/org/repo/pulls'))).toBe(true);
    expect(calls.some((u) => u.endsWith('/v1/events'))).toBe(true);
  });

  it('still posts an all-clear digest when a repo errors', async () => {
    const env = {
      EVT_API_URL: 'https://evt',
      EVT_API_KEY: 'k',
      EVT_ACCOUNT_ID: '16',
    } as NodeJS.ProcessEnv;
    const f = (async (url: string) => {
      if (url.includes('/pulls')) return { ok: false, status: 500, text: async () => 'boom' };
      return { ok: true, status: 200, text: async () => '' };
    }) as never;
    const warns: string[] = [];
    const res = await runPrReviewDigest({
      rbacPath: rbacFile({ 'org/repo': 'general' }),
      token: 'tok',
      env,
      fetchImpl: f,
      logger: { warn: (m) => warns.push(m) },
    });
    expect(res.prs).toBe(0);
    expect(res.sent).toBe(true);
    expect(warns.length).toBe(1);
  });
});
