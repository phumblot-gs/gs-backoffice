import { describe, it, expect, afterEach, vi } from 'vitest';
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

afterEach(() => vi.unstubAllGlobals());

const EVT_ENV = {
  EVT_API_URL: 'https://evt',
  EVT_API_KEY: 'k',
  EVT_ACCOUNT_ID: '16',
} as NodeJS.ProcessEnv;

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

/** Stub global fetch (used by EvtClient.publish); returns a captor of the last call. */
function stubEvtFetch(): { url?: string; body?: string } {
  const cap: { url?: string; body?: string } = {};
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    cap.url = url;
    cap.body = init.body as string;
    return { ok: true, status: 200, json: async () => ({ eventId: 'e1' }), text: async () => '{}' };
  });
  return cap;
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

describe('emitChatNotify (via shared EvtClient)', () => {
  it('publishes a notify event when EVT env is set', async () => {
    const cap = stubEvtFetch();
    expect(await emitChatNotify('hello', 'general', EVT_ENV)).toBe(true);
    expect(cap.url).toBe('https://evt/v1/events');
    const body = JSON.parse(cap.body as string);
    expect(body.eventType).toBe('backoffice.notify.google_chat');
    expect(body.payload).toEqual({ text: 'hello', scope: 'general' });
    expect(body.actor).toMatchObject({ userId: 'pr-review-digest', accountId: '16' });
  });
  it('no-ops (false) when EVT env missing', async () => {
    expect(await emitChatNotify('x', 'general', {} as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe('runPrReviewDigest', () => {
  it('gathers PRs across configured repos (injected GitHub fetch) and emits one digest (EvtClient)', async () => {
    const evt = stubEvtFetch();
    const ghCalls: string[] = [];
    const ghFetch = (async (url: string) => {
      ghCalls.push(url);
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify([
            { number: 9, title: 'X', html_url: 'http://x/9', draft: false, user: { login: 'z' } },
          ]),
      };
    }) as never;
    const res = await runPrReviewDigest({
      rbacPath: rbacFile({ 'org/repo': 'general' }),
      token: 'tok',
      env: EVT_ENV,
      fetchImpl: ghFetch,
    });
    expect(res).toEqual({ repos: 1, prs: 1, sent: true });
    expect(ghCalls.some((u) => u.includes('/repos/org/repo/pulls'))).toBe(true);
    expect(evt.url).toBe('https://evt/v1/events');
  });

  it('still posts an all-clear digest when a repo errors', async () => {
    stubEvtFetch();
    const ghFetch = (async () => ({ ok: false, status: 500, text: async () => 'boom' })) as never;
    const warns: string[] = [];
    const res = await runPrReviewDigest({
      rbacPath: rbacFile({ 'org/repo': 'general' }),
      token: 'tok',
      env: EVT_ENV,
      fetchImpl: ghFetch,
      logger: { warn: (m) => warns.push(m) },
    });
    expect(res.prs).toBe(0);
    expect(res.sent).toBe(true);
    expect(warns.length).toBe(1);
  });
});
