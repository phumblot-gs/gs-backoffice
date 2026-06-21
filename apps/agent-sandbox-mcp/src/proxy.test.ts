import { describe, it, expect } from 'vitest';
import {
  readProxyConfig,
  executeSandboxTool,
  ProxyConfigError,
  SANDBOX_PLUGIN_ID,
  type ProxyConfig,
} from './proxy.js';

const FULL_ENV = {
  PAPERCLIP_API_URL: 'https://backoffice-staging.grand-shooting.com/',
  PAPERCLIP_API_KEY: 'pc_key_123',
  PAPERCLIP_AGENT_ID: 'agent-1',
  PAPERCLIP_RUN_ID: 'run-1',
  PAPERCLIP_COMPANY_ID: 'co-1',
} as NodeJS.ProcessEnv;

describe('readProxyConfig', () => {
  it('reads run context and strips a trailing slash from the API url', () => {
    const cfg = readProxyConfig(FULL_ENV);
    expect(cfg.apiUrl).toBe('https://backoffice-staging.grand-shooting.com');
    expect(cfg.apiKey).toBe('pc_key_123');
    expect(cfg.runContext).toEqual({
      agentId: 'agent-1',
      runId: 'run-1',
      companyId: 'co-1',
      projectId: undefined,
    });
  });

  it('forwards projectId when PAPERCLIP_PROJECT_ID is set', () => {
    const cfg = readProxyConfig({ ...FULL_ENV, PAPERCLIP_PROJECT_ID: 'proj-9' });
    expect(cfg.runContext.projectId).toBe('proj-9');
  });

  it('throws listing every missing required var', () => {
    expect(() => readProxyConfig({ PAPERCLIP_API_URL: 'x' } as NodeJS.ProcessEnv)).toThrow(
      ProxyConfigError,
    );
    try {
      readProxyConfig({ PAPERCLIP_API_URL: 'x' } as NodeJS.ProcessEnv);
    } catch (e) {
      const m = (e as Error).message;
      expect(m).toContain('PAPERCLIP_API_KEY');
      expect(m).toContain('PAPERCLIP_AGENT_ID');
      expect(m).toContain('PAPERCLIP_RUN_ID');
      expect(m).toContain('PAPERCLIP_COMPANY_ID');
      expect(m).not.toContain('PAPERCLIP_API_URL'); // it was present
    }
  });
});

const CFG: ProxyConfig = {
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

describe('executeSandboxTool', () => {
  it('posts the namespaced tool + runContext and returns content+data', async () => {
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
    expect(body.runContext).toEqual({ agentId: 'a', runId: 'r', companyId: 'c' });
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
