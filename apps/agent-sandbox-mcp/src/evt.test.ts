import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  emitNotify,
  emitToolInvoked,
  emitEvolution,
  resolveNotifyScope,
  __resetRbacCache,
} from './evt.js';

beforeEach(() => __resetRbacCache());
afterEach(() => vi.unstubAllGlobals());

const EVT_ENV = {
  EVT_API_URL: 'https://evt.example.com',
  EVT_API_KEY: 'evt-key',
  EVT_ACCOUNT_ID: '16',
  PAPERCLIP_AGENT_ID: 'agent-1',
  NODE_ENV: 'staging',
} as NodeJS.ProcessEnv;

describe('durable stderr backstop (SOC2)', () => {
  it('writes the event to stderr even when EVT env is missing (no fetch)', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ok = await emitToolInvoked('open_pr', 'governance', true, {
      PAPERCLIP_AGENT_ID: 'agent-1',
      PAPERCLIP_TASK_ID: 'GRA-12',
    } as NodeJS.ProcessEnv);
    expect(ok).toBe(false); // no EVT env → no publish
    expect(fetchSpy).not.toHaveBeenCalled();
    // …but the event was still recorded to stderr for the run-log.
    expect(errSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(errSpy.mock.calls[0][0] as string);
    expect(logged.backoffice_audit.eventType).toBe('backoffice.audit.tool_invoked');
    expect(logged.backoffice_audit.payload).toMatchObject({ tool: 'open_pr', issueId: 'GRA-12' });
    errSpy.mockRestore();
  });
});

describe('emitNotify (via shared EvtClient)', () => {
  it('publishes a backoffice.notify.google_chat event with Bearer auth + text/scope payload', async () => {
    const cap: { url?: string; init?: RequestInit } = {};
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      cap.url = url;
      cap.init = init;
      return {
        ok: true,
        status: 200,
        json: async () => ({ eventId: 'e1' }),
        text: async () => '{}',
      };
    });
    const ok = await emitNotify(
      {
        text: 'PR #7 needs review',
        scope: 'engineering',
        resourceType: 'pull_request',
        resourceId: 'org/repo#7',
      },
      EVT_ENV,
    );
    expect(ok).toBe(true);
    expect(cap.url).toBe('https://evt.example.com/v1/events');
    expect((cap.init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer evt-key' });
    const body = JSON.parse((cap.init as RequestInit).body as string);
    expect(body.eventType).toBe('backoffice.notify.google_chat');
    expect(body.payload).toEqual({ text: 'PR #7 needs review', scope: 'engineering' });
    expect(body.actor).toMatchObject({ userId: 'agent-1', accountId: '16', role: 'agent' });
    expect(body.scope).toMatchObject({
      accountId: '16',
      resourceType: 'pull_request',
      resourceId: 'org/repo#7',
    });
    expect(body.source).toMatchObject({ application: 'gs-backoffice', environment: 'staging' });
  });

  it('no-ops (false) when EVT env is missing, without calling fetch', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(await emitNotify({ text: 't', scope: 'general' }, {} as NodeJS.ProcessEnv)).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns false (never throws) when the publish fails', async () => {
    // 403 → EvtClient throws immediately (no retry/backoff) → emitNotify swallows it.
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 403, text: async () => 'forbidden' }));
    expect(await emitNotify({ text: 't', scope: 'general' }, EVT_ENV)).toBe(false);
  });
});

describe('emitToolInvoked (audit, iso with employee tool calls)', () => {
  it('publishes backoffice.audit.tool_invoked with tool/category/ok + run context', async () => {
    const cap: { init?: RequestInit } = {};
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      cap.init = init;
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
    });
    const ok = await emitToolInvoked('open_pr', 'governance', true, {
      ...EVT_ENV,
      PAPERCLIP_RUN_ID: 'run-9',
      PAPERCLIP_TASK_ID: 'GRA-12',
    } as NodeJS.ProcessEnv);
    expect(ok).toBe(true);
    const body = JSON.parse((cap.init as RequestInit).body as string);
    expect(body.eventType).toBe('backoffice.audit.tool_invoked');
    expect(body.scope).toMatchObject({ resourceType: 'tool', resourceId: 'open_pr' });
    expect(body.payload).toMatchObject({
      tool: 'open_pr',
      category: 'governance',
      ok: true,
      agentId: 'agent-1',
      runId: 'run-9',
      issueId: 'GRA-12',
    });
  });

  it('no-ops (false) when EVT env is missing', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(await emitToolInvoked('get_diff', 'review', false, {} as NodeJS.ProcessEnv)).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('emitEvolution (lifecycle)', () => {
  it('publishes the lifecycle event scoped to the run issue, merging payload', async () => {
    const cap: { init?: RequestInit } = {};
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      cap.init = init;
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
    });
    const ok = await emitEvolution(
      'backoffice.evolution.pr_opened',
      { number: 7, url: 'https://gh/pr/7' },
      { ...EVT_ENV, PAPERCLIP_TASK_ID: 'GRA-12' } as NodeJS.ProcessEnv,
    );
    expect(ok).toBe(true);
    const body = JSON.parse((cap.init as RequestInit).body as string);
    expect(body.eventType).toBe('backoffice.evolution.pr_opened');
    expect(body.scope).toMatchObject({ resourceType: 'evolution', resourceId: 'GRA-12' });
    expect(body.payload).toMatchObject({
      issueId: 'GRA-12',
      agentId: 'agent-1',
      number: 7,
      url: 'https://gh/pr/7',
    });
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
    expect(resolveNotifyScope('org/repo', writeRbac({ 'org/repo': 'Engineering' }))).toBe(
      'engineering',
    );
  });

  it('defaults to general for an unmapped repo or missing file', () => {
    expect(resolveNotifyScope('org/other', writeRbac({ 'org/repo': 'x' }))).toBe('general');
    __resetRbacCache();
    expect(resolveNotifyScope('org/repo', '/no/such/rbac.json')).toBe('general');
  });
});
