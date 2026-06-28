import { describe, it, expect, beforeEach } from 'vitest';
import {
  readProxyConfig,
  resolveProjectId,
  resolveProjectContext,
  resolveRepoUrl,
  resolveEngineerAgentId,
  executeSandboxTool,
  reportProgress,
  parseGitHubRepo,
  githubToken,
  openPr,
  getDiff,
  createChildIssue,
  getIssue,
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

/** A fetch mock that routes by URL substring (for multi-endpoint resolution paths). */
function routedFetch(routes: Array<{ match: string; status?: number; payload: unknown }>) {
  return (async (url: string) => {
    const r = routes.find((x) => url.includes(x.match));
    if (!r) return { ok: false, status: 404, text: async () => `no route for ${url}` };
    const status = r.status ?? 200;
    const text = typeof r.payload === 'string' ? r.payload : JSON.stringify(r.payload);
    return { ok: status >= 200 && status < 300, status, text: async () => text };
  }) as never;
}

const CTX_CFG: ProxyConfig = {
  ...BASE_CFG,
  runContext: { ...BASE_CFG.runContext, projectId: 'p' },
};

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

  it("prefers the run issue's projectId over the company project list", async () => {
    const f = routedFetch([
      { match: '/api/issues/iss-1', payload: { id: 'iss-1', projectId: 'p-issue' } },
      { match: '/api/companies/c/projects', payload: { projects: [{ id: 'p-other' }] } },
    ]);
    expect(await resolveProjectId({ ...BASE_CFG, taskIssueId: 'iss-1' }, f)).toBe('p-issue');
  });

  it('falls back to project.id when the issue has no flat projectId', async () => {
    const f = routedFetch([
      { match: '/api/issues/iss-2', payload: { id: 'iss-2', project: { id: 'p-nested' } } },
    ]);
    expect(await resolveProjectId({ ...BASE_CFG, taskIssueId: 'iss-2' }, f)).toBe('p-nested');
  });

  it('falls back to the first company project when the issue has no project', async () => {
    const f = routedFetch([
      { match: '/api/issues/iss-3', payload: { id: 'iss-3', projectId: null, project: null } },
      { match: '/api/companies/c/projects', payload: { projects: [{ id: 'p-first' }] } },
    ]);
    expect(await resolveProjectId({ ...BASE_CFG, taskIssueId: 'iss-3' }, f)).toBe('p-first');
  });
});

describe('resolveProjectContext', () => {
  it('resolves repoUrl + defaultRef from codebase and the engineer agent', async () => {
    const f = routedFetch([
      {
        match: '/api/projects/p',
        payload: { codebase: { repoUrl: 'https://github.com/o/r.git', defaultRef: 'main' } },
      },
      {
        match: '/api/companies/c/agents',
        payload: [
          { id: 'mo', role: 'cto' },
          { id: 'eng', role: 'engineer' },
        ],
      },
    ]);
    expect(await resolveProjectContext(CTX_CFG, f)).toEqual({
      projectId: 'p',
      repoUrl: 'https://github.com/o/r.git',
      defaultRef: 'main',
      engineerAgentId: 'eng',
    });
  });

  it('falls back to primaryWorkspace.repoUrl and leaves engineer undefined when none', async () => {
    const f = routedFetch([
      {
        match: '/api/projects/p',
        payload: {
          codebase: { repoUrl: null },
          primaryWorkspace: { repoUrl: 'https://gh/o/r2.git' },
        },
      },
      { match: '/api/companies/c/agents', payload: { agents: [{ id: 'mo', role: 'cto' }] } },
    ]);
    const ctx = await resolveProjectContext(CTX_CFG, f);
    expect(ctx.repoUrl).toBe('https://gh/o/r2.git');
    expect(ctx.engineerAgentId).toBeUndefined();
  });

  it('caches the context (second call does not refetch)', async () => {
    const f = routedFetch([
      { match: '/api/projects/p', payload: { codebase: { repoUrl: 'u' } } },
      { match: '/api/companies/c/agents', payload: [{ id: 'eng', role: 'engineer' }] },
    ]);
    await resolveProjectContext(CTX_CFG, f);
    const ctx2 = await resolveProjectContext(CTX_CFG, (async () => {
      throw new Error('should not refetch');
    }) as never);
    expect(ctx2.engineerAgentId).toBe('eng');
  });
});

describe('resolveRepoUrl / resolveEngineerAgentId', () => {
  it('returns the explicit repoUrl without any fetch', async () => {
    const url = await resolveRepoUrl(CTX_CFG, 'https://github.com/o/explicit.git', (async () => {
      throw new Error('should not fetch');
    }) as never);
    expect(url).toBe('https://github.com/o/explicit.git');
  });

  it('resolves repoUrl from project context when omitted', async () => {
    const f = routedFetch([
      {
        match: '/api/projects/p',
        payload: { codebase: { repoUrl: 'https://github.com/o/r.git' } },
      },
      { match: '/api/companies/c/agents', payload: [] },
    ]);
    expect(await resolveRepoUrl(CTX_CFG, undefined, f)).toBe('https://github.com/o/r.git');
  });

  it('falls back to BACKOFFICE_REPO_URL when the project has no repo bound', async () => {
    const f = routedFetch([
      { match: '/api/projects/p', payload: { codebase: { repoUrl: null } } },
      { match: '/api/companies/c/agents', payload: [] },
    ]);
    const env = { BACKOFFICE_REPO_URL: 'https://github.com/o/env-repo.git' } as NodeJS.ProcessEnv;
    expect(await resolveRepoUrl(CTX_CFG, undefined, f, env)).toBe(
      'https://github.com/o/env-repo.git',
    );
  });

  it('throws a precise error when nothing provides a repoUrl', async () => {
    const f = routedFetch([
      { match: '/api/projects/p', payload: { codebase: { repoUrl: null } } },
      { match: '/api/companies/c/agents', payload: [] },
    ]);
    await expect(resolveRepoUrl(CTX_CFG, undefined, f, {} as NodeJS.ProcessEnv)).rejects.toThrow(
      /BACKOFFICE_REPO_URL is unset/,
    );
  });

  it('returns the explicit assignee, else resolves the engineer', async () => {
    expect(
      await resolveEngineerAgentId(CTX_CFG, 'explicit-agent', (async () => {
        throw new Error('should not fetch');
      }) as never),
    ).toBe('explicit-agent');
    const f = routedFetch([
      { match: '/api/projects/p', payload: { codebase: { repoUrl: 'u' } } },
      { match: '/api/companies/c/agents', payload: [{ id: 'eng', role: 'engineer' }] },
    ]);
    expect(await resolveEngineerAgentId(CTX_CFG, undefined, f)).toBe('eng');
  });

  it('throws when no engineer agent exists', async () => {
    const f = routedFetch([
      { match: '/api/projects/p', payload: {} },
      { match: '/api/companies/c/agents', payload: [{ id: 'mo', role: 'cto' }] },
    ]);
    await expect(resolveEngineerAgentId(CTX_CFG, undefined, f)).rejects.toThrow(/role "engineer"/);
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

describe('reportProgress', () => {
  const CFG_TASK: ProxyConfig = {
    apiUrl: 'https://host',
    apiKey: 'k',
    runContext: { agentId: 'a', runId: 'run-7', companyId: 'c', projectId: 'p' },
    taskIssueId: 'issue-default',
  };

  it('PATCHes the default issue with status+comment and the run-id header', async () => {
    const cap: { url?: string; init?: RequestInit } = {};
    const f = fakeFetch(200, { status: 'done', identifier: 'GRA-42' }, cap);
    const r = await reportProgress(CFG_TASK, { status: 'done', comment: 'all good' }, f);

    expect(cap.url).toBe('https://host/api/issues/issue-default');
    const init = cap.init as RequestInit;
    expect(init.method).toBe('PATCH');
    expect(init.headers).toMatchObject({
      'X-Paperclip-Run-Id': 'run-7',
      Authorization: 'Bearer k',
    });
    expect(JSON.parse(init.body as string)).toEqual({ status: 'done', comment: 'all good' });
    expect(r).toEqual({ status: 'done', identifier: 'GRA-42' });
  });

  it('honors an explicit issueId override', async () => {
    const cap: { url?: string } = {};
    const f = fakeFetch(200, { status: 'blocked' }, cap);
    await reportProgress(CFG_TASK, { issueId: 'other', comment: 'x' }, f);
    expect(cap.url).toBe('https://host/api/issues/other');
  });

  it('requires an issue id', async () => {
    const f = fakeFetch(200, {});
    await expect(
      reportProgress({ ...CFG_TASK, taskIssueId: undefined }, { comment: 'x' }, f),
    ).rejects.toThrow(/needs an issueId/);
  });

  it('requires status or comment', async () => {
    const f = fakeFetch(200, {});
    await expect(reportProgress(CFG_TASK, {}, f)).rejects.toThrow(
      /at least one of status or comment/,
    );
  });

  it('surfaces an HTTP error', async () => {
    const f = fakeFetch(422, 'bad status transition');
    await expect(reportProgress(CFG_TASK, { status: 'done' }, f)).rejects.toThrow(
      /report_progress → HTTP 422.*bad status/,
    );
  });
});

describe('parseGitHubRepo', () => {
  it('parses https + .git + ssh forms', () => {
    expect(parseGitHubRepo('https://github.com/org/repo.git')).toEqual({
      owner: 'org',
      repo: 'repo',
    });
    expect(parseGitHubRepo('https://github.com/org/repo')).toEqual({ owner: 'org', repo: 'repo' });
    expect(parseGitHubRepo('git@github.com:org/repo.git')).toEqual({ owner: 'org', repo: 'repo' });
  });
  it('throws on a non-github url', () => {
    expect(() => parseGitHubRepo('https://gitlab.com/o/r.git')).toThrow(/cannot parse/);
  });
});

describe('githubToken', () => {
  it('prefers the scoped token, falls back to the combined one', () => {
    expect(
      githubToken('push', {
        SANDBOX_GITHUB_PUSH_TOKEN: 'p',
        SANDBOX_GITHUB_TOKEN: 'c',
      } as NodeJS.ProcessEnv),
    ).toBe('p');
    expect(githubToken('read', { SANDBOX_GITHUB_TOKEN: 'c' } as NodeJS.ProcessEnv)).toBe('c');
  });
  it('throws when no token is present', () => {
    expect(() => githubToken('push', {} as NodeJS.ProcessEnv)).toThrow(/no GitHub push token/);
  });
});

const GH_ENV = {
  SANDBOX_GITHUB_PUSH_TOKEN: 'push-tok',
  SANDBOX_GITHUB_READ_TOKEN: 'read-tok',
} as NodeJS.ProcessEnv;

describe('openPr', () => {
  it('POSTs to the repo pulls endpoint with the push token and returns number+url', async () => {
    const cap: { url?: string; init?: RequestInit } = {};
    const f = fakeFetch(201, { number: 7, html_url: 'https://github.com/org/repo/pull/7' }, cap);
    const r = await openPr(
      { repoUrl: 'https://github.com/org/repo.git', head: 'eng/x', title: 'T', body: 'B' },
      f,
      GH_ENV,
    );
    expect(cap.url).toBe('https://api.github.com/repos/org/repo/pulls');
    const init = cap.init as RequestInit;
    expect(init.headers).toMatchObject({ Authorization: 'Bearer push-tok' });
    expect(JSON.parse(init.body as string)).toMatchObject({
      head: 'eng/x',
      base: 'main',
      title: 'T',
    });
    expect(r).toEqual({ number: 7, url: 'https://github.com/org/repo/pull/7' });
  });
  it('surfaces a GitHub error', async () => {
    const f = fakeFetch(422, '{"message":"No commits between main and eng/x"}');
    await expect(
      openPr({ repoUrl: 'https://github.com/org/repo.git', head: 'eng/x', title: 'T' }, f, GH_ENV),
    ).rejects.toThrow(/open_pr → HTTP 422.*No commits/);
  });
});

describe('getDiff', () => {
  it('GETs the compare endpoint with the read token + diff accept header', async () => {
    const cap: { url?: string; init?: RequestInit } = {};
    const f = fakeFetch(200, 'diff --git a/x b/x\n+line', cap);
    const out = await getDiff(
      { repoUrl: 'https://github.com/org/repo.git', base: 'main', head: 'eng/x' },
      f,
      GH_ENV,
    );
    expect(cap.url).toBe('https://api.github.com/repos/org/repo/compare/main...eng%2Fx');
    expect((cap.init as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer read-tok',
      Accept: 'application/vnd.github.diff',
    });
    expect(out).toContain('diff --git');
  });
  it('truncates an oversized diff', async () => {
    const big = 'x'.repeat(120);
    const f = fakeFetch(200, big);
    const out = await getDiff(
      { repoUrl: 'https://github.com/org/repo.git', base: 'main', head: 'h', maxBytes: 50 },
      f,
      GH_ENV,
    );
    expect(out).toContain('truncated at 50 bytes');
    expect(out.length).toBeLessThan(big.length + 100);
  });
});

const GOV_CFG: ProxyConfig = {
  apiUrl: 'https://host',
  apiKey: 'k',
  runContext: { agentId: 'a', runId: 'run-9', companyId: 'co-1', projectId: 'p' },
  taskIssueId: 'parent-issue',
};

describe('createChildIssue', () => {
  it('POSTs a child under the current issue with assignee + criteria + run header', async () => {
    const cap: { url?: string; init?: RequestInit } = {};
    const f = fakeFetch(201, { id: 'child-1', identifier: 'GRA-50', status: 'backlog' }, cap);
    const r = await createChildIssue(
      GOV_CFG,
      {
        title: 'Step 1',
        description: 'do x',
        assigneeAgentId: 'eng-1',
        acceptanceCriteria: ['x works'],
        blockParentUntilDone: true,
      },
      f,
    );
    expect(cap.url).toBe('https://host/api/companies/co-1/issues');
    const init = cap.init as RequestInit;
    expect(init.headers).toMatchObject({ 'X-Paperclip-Run-Id': 'run-9' });
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      parentId: 'parent-issue',
      assigneeAgentId: 'eng-1',
      acceptanceCriteria: ['x works'],
      blockParentUntilDone: true,
    });
    expect(r).toEqual({ id: 'child-1', identifier: 'GRA-50', status: 'backlog' });
  });

  it('defaults blockParentUntilDone to true and omits empty criteria', async () => {
    const cap: { init?: RequestInit } = {};
    const f = fakeFetch(201, { id: 'c2' }, cap);
    await createChildIssue(GOV_CFG, { title: 't', assigneeAgentId: 'eng-1' }, f);
    const body = JSON.parse((cap.init as RequestInit).body as string);
    expect(body.blockParentUntilDone).toBe(true);
    expect('acceptanceCriteria' in body).toBe(false);
  });

  it('requires a parent and an assignee', async () => {
    const f = fakeFetch(201, { id: 'x' });
    await expect(
      createChildIssue(
        { ...GOV_CFG, taskIssueId: undefined },
        { title: 't', assigneeAgentId: 'e' },
        f,
      ),
    ).rejects.toThrow(/needs a parentId/);
    await expect(createChildIssue(GOV_CFG, { title: 't', assigneeAgentId: '' }, f)).rejects.toThrow(
      /requires assigneeAgentId/,
    );
  });

  it('surfaces an HTTP error', async () => {
    const f = fakeFetch(422, 'bad parent');
    await expect(
      createChildIssue(GOV_CFG, { title: 't', assigneeAgentId: 'e' }, f),
    ).rejects.toThrow(/create_child_issue → HTTP 422.*bad parent/);
  });
});

describe('getIssue', () => {
  it('returns issue core + latest comments', async () => {
    let n = 0;
    const f = (async (url: string) => {
      n += 1;
      if (url.endsWith('/comments')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify([{ body: 'first' }, { body: 'Engineer: done, PR #9' }]),
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: 'child-1',
            identifier: 'GRA-50',
            title: 'Step 1',
            status: 'done',
            assigneeAgentId: 'eng-1',
          }),
      };
    }) as never;
    const v = await getIssue(GOV_CFG, 'child-1', f);
    expect(n).toBe(2);
    expect(v.status).toBe('done');
    expect(v.identifier).toBe('GRA-50');
    expect(v.comments.map((c) => c.body)).toEqual(['first', 'Engineer: done, PR #9']);
  });

  it('still returns the issue if comments fetch fails', async () => {
    const f = (async (url: string) => {
      if (url.endsWith('/comments')) return { ok: false, status: 500, text: async () => 'err' };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: 'i', status: 'in_progress' }),
      };
    }) as never;
    const v = await getIssue(GOV_CFG, 'i', f);
    expect(v.status).toBe('in_progress');
    expect(v.comments).toEqual([]);
  });

  it('surfaces an HTTP error on the issue fetch', async () => {
    const f = fakeFetch(404, 'not found');
    await expect(getIssue(GOV_CFG, 'missing', f)).rejects.toThrow(/get_issue → HTTP 404/);
  });
});
