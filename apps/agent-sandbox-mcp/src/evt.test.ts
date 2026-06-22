import { describe, it, expect, beforeEach } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emitNotify, resolveNotifyScope, __resetRbacCache } from './evt.js';

beforeEach(() => __resetRbacCache());

const EVT_ENV = {
  EVT_API_URL: 'https://evt.example.com/',
  EVT_API_KEY: 'evt-key',
  EVT_ACCOUNT_ID: '16',
  PAPERCLIP_AGENT_ID: 'agent-1',
  NODE_ENV: 'staging',
} as NodeJS.ProcessEnv;

describe('emitNotify', () => {
  it('POSTs a backoffice.notify.google_chat event with Bearer auth + text/scope payload', async () => {
    const cap: { url?: string; init?: RequestInit } = {};
    const f = (async (url: string, init: RequestInit) => {
      cap.url = url;
      cap.init = init;
      return { ok: true, status: 200 };
    }) as never;
    const ok = await emitNotify(
      {
        text: 'PR #7 needs review',
        scope: 'engineering',
        resourceType: 'pull_request',
        resourceId: 'org/repo#7',
      },
      EVT_ENV,
      f,
    );
    expect(ok).toBe(true);
    expect(cap.url).toBe('https://evt.example.com/v1/events');
    const init = cap.init as RequestInit;
    expect(init.headers).toMatchObject({ Authorization: 'Bearer evt-key' });
    const body = JSON.parse(init.body as string);
    expect(body.eventType).toBe('backoffice.notify.google_chat');
    expect(body.payload).toEqual({ text: 'PR #7 needs review', scope: 'engineering' });
    expect(body.actor).toMatchObject({ userId: 'agent-1', accountId: '16' });
    expect(body.scope).toMatchObject({
      accountId: '16',
      resourceType: 'pull_request',
      resourceId: 'org/repo#7',
    });
    expect(body.source.environment).toBe('staging');
  });

  it('no-ops (returns false) when EVT env is missing, without throwing', async () => {
    const called = { hit: false };
    const f = (async () => {
      called.hit = true;
      return { ok: true, status: 200 };
    }) as never;
    expect(await emitNotify({ text: 't', scope: 'general' }, {} as NodeJS.ProcessEnv, f)).toBe(
      false,
    );
    expect(called.hit).toBe(false);
  });

  it('returns false (never throws) when the request fails', async () => {
    const f = (async () => {
      throw new Error('network down');
    }) as never;
    expect(await emitNotify({ text: 't', scope: 'general' }, EVT_ENV, f)).toBe(false);
  });
});

describe('resolveNotifyScope', () => {
  function writeRbac(repos: Record<string, string> | undefined): string {
    const dir = mkdtempSync(join(tmpdir(), 'rbac-'));
    const path = join(dir, 'rbac.json');
    writeFileSync(path, JSON.stringify({ companies: {}, ...(repos ? { repos } : {}) }));
    return path;
  }

  it('returns the mapped scope (lowercased) for a known repo', () => {
    const path = writeRbac({ 'org/repo': 'Engineering' });
    expect(resolveNotifyScope('org/repo', path)).toBe('engineering');
  });

  it('defaults to general for an unmapped repo or missing/invalid file', () => {
    expect(resolveNotifyScope('org/other', writeRbac({ 'org/repo': 'x' }))).toBe('general');
    __resetRbacCache();
    expect(resolveNotifyScope('org/repo', '/no/such/rbac.json')).toBe('general');
  });
});
