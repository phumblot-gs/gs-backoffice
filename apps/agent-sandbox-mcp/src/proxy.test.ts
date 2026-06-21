import { describe, it, expect, beforeEach } from 'vitest';
import {
  readProxyConfig,
  resolveProjectId,
  executeSandboxTool,
  __resetProjectCache,
  ProxyConfigError,
  SANDBOX_PLUGIN_ID,
  type ProxyConfig,
} from './proxy.js';

const FULL_ENV = {
  PAPERCLIP_API_KEY: 'pc_key_123',
  PAPERCLIP_AGENT_ID: 'agent-1',
  PAPERCLIP_RUN_ID: 'run-1',
  PAPERCLIP_COMPANY_ID: 'co-1',
} as NodeJS.ProcessEnv;

beforeEach(() => __resetProjectCache());

describe('readProxyConfig', () => {
  it('uses loopback (default port 3100) to bypass the ALB, not the public URL', () => {
    const cfg = readProxyConfig({
      ...FULL_ENV,
      PAPERCLIP_API_URL: 'https://backoffice-staging.grand-shooting.com',
    } as NodeJS.ProcessEnv);
    expect(cfg.apiUrl).toBe('http://127.0.0.1:3100');
    expect(cfg.apiKey).toBe('pc_key_123');
    expect(cfg.runContext).toEqual({
      agentId: 'agent-1',
      runId: 'run-1',
      companyId: 'co-1',
      projectId: undefined,
    });
  });

  it('honors PORT for the loopback url', () => {
    const cfg = readProxyConfig({ ...FULL_ENV, PORT: '4000' } as NodeJS.ProcessEnv);
    expect(cfg.apiUrl).toBe('http://127.0.0.1:4000');
  });

  it('honors an explicit PAPERCLIP_SANDBOX_API_URL override (trailing slash stripped)', () => {
    const cfg = readProxyConfig({
      ...FULL_ENV,
      PAPERCLIP_SANDBOX_API_URL: 'http://paperclip.internal:9/',
    } as NodeJS.ProcessEnv);
    expect(cfg.apiUrl).toBe('http://paperclip.internal:9');
  });

  it('forwards projectId when PAPERCLIP_PROJECT_ID is set', () => {
    const cfg = readProxyConfig({ ...FULL_ENV, PAPERCLIP_PROJECT_ID: 'proj-9' });
    expect(cfg.runContext.projectId).toBe('proj-9');
  });

  it('does not require projectId (resolved separately)', () => {
    expect(() => readProxyConfig(FULL_ENV)).not.toThrow();
  });

  it('throws listing every missing required var (projectId + apiUrl excepted)', () => {
    expect(() => readProxyConfig({ PAPERCLIP_API_KEY: 'x' } as NodeJS.ProcessEnv)).toThrow(
      ProxyConfigError,
    );
    try {
      readProxyConfig({ PAPERCLIP_API_KEY: 'x' } as NodeJS.ProcessEnv);
    } catch (e) {
      const m = (e as Error).message;
      expect(m).toContain('PAPERCLIP_AGENT_ID');
      expect(m).toContain('PAPERCLIP_RUN_ID');
      expect(m).toContain('PAPERCLIP_COMPANY_ID');
      expect(m).not.toContain('PAPERCLIP_API_KEY'); // present
      expect(m).not.toContain('PAPERCLIP_PROJECT_ID'); // resolved separately
      expect(m).not.toContain('PAPERCLIP_API_URL'); // loopback, not required
    }
  });
});

const BASE_CFG: ProxyConfig = {
  apiUrl: 'https://host',
  apiKey: 'k',
  runContext: { agentId: 'a', runId: 'r', companyId: 'c' },
};

function fakeFetch(
  status: number,
  payload: unknown,
  capture?: { url?: string; init?: RequestInit },
) {
  return async (url: string, init: RequestInit) => {
    if (capture) {
      capture.url = url;
      capture.init = init;
    }
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return { ok: status >= 200 && status < 300, status, text: async () => text };
  };
}

describe('resolveProjectId', () => {
  it('uses the env-provided projectId without any fetch', async () => {
    let called = false;
    const f = (async () => {
      called = true;
      return { ok: true, status: 200, text: async () => '[]' };
    }) as never;
    const id = await resolveProjectId(
      { ...BASE_CFG, runContext: { ...BASE_CFG.runContext, projectId: 'p-env' } },
      f,
    );
    expect(id).toBe('p-env');
    expect(called).toBe(false);
  });

  it('fetches the first authorized company project and caches it', async () => {
    const cap: { url?: string } = {};
    const f = fakeFetch(200, { projects: [{ id: 'p-first', name: 'A' }, { id: 'p-2' }] }, cap);
    const id = await resolveProjectId(BASE_CFG, f);
    expect(id).toBe('p-first');
    expect(cap.url).toBe('https://host/api/companies/c/projects');
    // second call is served from cache (a throwing fetch must not be hit)
    const id2 = await resolveProjectId(BASE_CFG, (async () => {
      throw new Error('should not fetch again');
    }) as never);
    expect(id2).toBe('p-first');
  });

  it('throws a clear error when the actor has no authorized projects', async () => {
    const f = fakeFetch(200, { projects: [] });
    await expect(resolveProjectId(BASE_CFG, f)).rejects.toThrow(/no authorized projects/);
  });

  it('surfaces an HTTP error from the projects listing', async () => {
    const f = fakeFetch(403, 'forbidden');
    await expect(resolveProjectId(BASE_CFG, f)).rejects.toThrow(
      /cannot resolve projectId.*HTTP 403/,
    );
  });
});

const CFG: ProxyConfig = {
  apiUrl: 'https://host',
  apiKey: 'k',
  runContext: { agentId: 'a', runId: 'r', companyId: 'c', projectId: 'p' },
};

describe('executeSandboxTool', () => {
  it('posts the namespaced tool + full runContext (incl. projectId) and returns content+data', async () => {
    const cap: { url?: string; init?: RequestInit } = {};
    const f = fakeFetch(
      200,
      {
        result: {
          content: 'Command exited 0 in sandbox.',
          data: { exitCode: 0, checkedOutSha: 'abc123' },
        },
      },
      cap,
    );
    const r = await executeSandboxTool(
      CFG,
      'sandbox_run',
      { sandboxKey: 'k', repoUrl: 'u', ref: 'main', command: 'node -v' },
      f,
    );

    expect(cap.url).toBe('https://host/api/plugins/tools/execute');
    const body = JSON.parse((cap.init as RequestInit).body as string);
    expect(body.tool).toBe(`${SANDBOX_PLUGIN_ID}:sandbox_run`);
    expect(body.runContext).toEqual({ agentId: 'a', runId: 'r', companyId: 'c', projectId: 'p' });
    expect(body.parameters.command).toBe('node -v');
    expect((cap.init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer k' });

    expect(r.content).toBe('Command exited 0 in sandbox.');
    expect(r.data).toEqual({ exitCode: 0, checkedOutSha: 'abc123' });
  });

  it('throws on an HTTP error with the status + body', async () => {
    const f = fakeFetch(500, 'boom', undefined);
    await expect(
      executeSandboxTool(CFG, 'sandbox_release', { sandboxKey: 'k' }, f),
    ).rejects.toThrow(/HTTP 500.*boom/);
  });

  it('throws when the tool result carries an error', async () => {
    const f = fakeFetch(200, { result: { error: { message: 'sprite gone' } } }, undefined);
    await expect(executeSandboxTool(CFG, 'sandbox_run', {}, f)).rejects.toThrow(
      /tool error.*sprite gone/,
    );
  });

  it('falls back to a default summary when content is absent', async () => {
    const f = fakeFetch(200, { result: { data: { released: true } } }, undefined);
    const r = await executeSandboxTool(CFG, 'sandbox_release', { sandboxKey: 'k' }, f);
    expect(r.content).toBe('sandbox_release completed.');
    expect(r.data).toEqual({ released: true });
  });
});
