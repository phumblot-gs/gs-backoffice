import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { AgentsAuthzLoadError, loadAgentsAuthz, type EvtEvent } from '@gs-backoffice/core';
import { JOB_FAILURE_MARKER, runDriftCheck, type DriftCheckDeps } from './check.js';
import type { ReadOnlyPaperclip } from './collect.js';

/**
 * Integration-style: the real shipped config/agents-authz.json, the real collector and
 * comparison, against a FAKE read-only Paperclip shaped like the staging inventory
 * (2026.824.1) — brought to the target posture, then mutated per scenario.
 */
const SHIPPED = fileURLToPath(new URL('../../../config/agents-authz.json', import.meta.url));
const COMPANY = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';
const CEO = '80096853-250b-4fbe-b24c-b5d8438f6a0a';
const MO = 'e9ef031e-e895-48d2-b642-6c0b1ca96298';
const ENG = 'cf4d5caf-a68c-48f5-a302-1c4db6e05d2d';
const PLANTED_SECRET = 'sk-ant-api03-PLANTED-SECRET-VALUE-DO-NOT-LEAK';

const MO_TOOLS =
  'ToolSearch Read Grep Glob TodoWrite mcp__gs-sandbox__sandbox_run mcp__gs-sandbox__sandbox_code_task mcp__gs-sandbox__sandbox_release mcp__gs-sandbox__report_progress mcp__gs-sandbox__get_diff mcp__gs-sandbox__open_pr mcp__gs-sandbox__create_child_issue mcp__gs-sandbox__get_issue';
const ENG_TOOLS =
  'ToolSearch Read Grep Glob TodoWrite mcp__gs-sandbox__sandbox_run mcp__gs-sandbox__sandbox_code_task mcp__gs-sandbox__sandbox_release mcp__gs-sandbox__report_progress mcp__gs-sandbox__get_diff mcp__gs-sandbox__open_pr';

type Rec = Record<string, unknown>;

function compliantWorld() {
  const agent = (id: string, name: string, role: string, model: string, tools?: string): Rec => ({
    id,
    companyId: COMPANY,
    name,
    role,
    status: 'idle',
    adapterType: 'claude_local',
    adapterConfig: {
      // A credential in adapterConfig.env, exactly like the real CEO agent: must never leak.
      env: { ANTHROPIC_API_KEY: PLANTED_SECRET },
      model,
      ...(tools
        ? {
            extraArgs: [
              '--mcp-config',
              '/opt/gs-agent-tools/mcp-config.json',
              '--allowedTools',
              tools,
            ],
          }
        : {}),
      dangerouslySkipPermissions: false,
    },
    permissions: { canCreateAgents: false, canCreateSkills: false },
  });
  const agents: Rec[] = [
    // The CEO holds a hiringException in the file, so canCreateAgents=true is compliant.
    {
      ...agent(CEO, 'CEO', 'ceo', 'claude-haiku-4-5-20251001'),
      permissions: { canCreateAgents: true, canCreateSkills: false },
    },
    agent(MO, 'Methods Officer', 'cto', 'claude-sonnet-4-6', MO_TOOLS),
    agent(ENG, 'Engineer', 'engineer', 'claude-haiku-4-5-20251001', ENG_TOOLS),
  ];
  const grants: Record<string, Array<{ permissionKey: string; scope: Rec | null }>> = {
    [MO]: [],
    [CEO]: [],
    [ENG]: [],
  };
  const company: Rec = { id: COMPANY, requireBoardApprovalForNewAgents: true };
  const writes = vi.fn(); // any write attempt would land here — there is no write surface
  const paperclip: ReadOnlyPaperclip = {
    companies: { get: async (id) => (id === COMPANY ? company : null) },
    agents: { list: async ({ offset = 0 }) => (offset === 0 ? agents : []) },
    authorization: { grants: { list: async ({ principalId }) => grants[principalId!] ?? [] } },
  };
  return { agents, grants, company, paperclip, writes };
}

function harness(world = compliantWorld(), overrides: Partial<DriftCheckDeps> = {}) {
  const published: EvtEvent[] = [];
  const logs: Array<{ level: string; msg: string; meta?: Rec }> = [];
  const deps: DriftCheckDeps = {
    paperclip: world.paperclip,
    companyId: COMPANY,
    environment: 'staging',
    loadConfig: () => loadAgentsAuthz(SHIPPED),
    evt: { accountId: 'acct-1', publish: async (e) => void published.push(e) },
    chatScope: 'leadership',
    logger: {
      info: (msg, meta) => logs.push({ level: 'info', msg, meta }),
      warn: (msg, meta) => logs.push({ level: 'warn', msg, meta }),
      error: (msg, meta) => logs.push({ level: 'error', msg, meta }),
    },
    trigger: 'manual',
    ...overrides,
  };
  return { deps, published, logs, world };
}

const driftEvents = (published: EvtEvent[]) =>
  published.filter((e) => e.eventType === 'backoffice.authz.drift');
const chatEvents = (published: EvtEvent[]) =>
  published.filter((e) => e.eventType === 'backoffice.notify.google_chat');
const actionable = (published: EvtEvent[]) =>
  driftEvents(published).filter((e) => e.payload.status !== 'unverifiable');

describe('authz drift job (mocked Paperclip)', () => {
  it('a compliant staging produces no actionable drift and no chat alert', async () => {
    const h = harness();
    const res = await runDriftCheck(h.deps);
    expect(res.ok).toBe(true);
    expect(actionable(h.published)).toEqual([]);
    expect(chatEvents(h.published)).toEqual([]);
  });

  it('unobservable fields are published explicitly as unverifiable', async () => {
    const h = harness();
    await runDriftCheck(h.deps);
    const paths = driftEvents(h.published)
      .filter((e) => e.payload.status === 'unverifiable')
      .map((e) => `${e.payload.agentSlug ?? '-'}:${e.payload.path}`);
    expect(paths).toEqual(
      expect.arrayContaining([
        '-:instance.runnerApiToolsEnabled',
        '-:instance.experimental.enablePublicMcp',
        'engineer:runsIn',
        'engineer:connectors',
        'engineer:access.canAssignTasks',
        'methods-officer:access.canAssignTasks',
      ]),
    );
    // The CEO's task assignment IS observable (ceo role) — so it is not listed.
    expect(paths).not.toContain('ceo:access.canAssignTasks');
  });

  it('detects canCreateAgents switched on for an agent without a hiring exception', async () => {
    const w = compliantWorld();
    (w.agents[2].permissions as Rec).canCreateAgents = true;
    const h = harness(w);
    const res = await runDriftCheck(h.deps);
    expect(res.ok).toBe(false);
    expect(actionable(h.published)).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          environment: 'staging',
          agentSlug: 'engineer',
          path: 'permissions.canCreateAgents',
          expected: false,
          actual: true,
          status: 'drift',
        }),
      }),
    ]);
    const chat = chatEvents(h.published);
    expect(chat).toHaveLength(1);
    expect(chat[0].payload.scope).toBe('leadership');
    expect(String(chat[0].payload.text)).toContain('engineer — permissions.canCreateAgents');
    expect(h.logs.some((l) => l.level === 'error' && l.msg.startsWith(JOB_FAILURE_MARKER))).toBe(
      true,
    );
  });

  it('detects a switched approval mode (dangerouslySkipPermissions → true)', async () => {
    const w = compliantWorld();
    (w.agents[1].adapterConfig as Rec).dangerouslySkipPermissions = true;
    const h = harness(w);
    await runDriftCheck(h.deps);
    expect(
      actionable(h.published).map((e) => [e.payload.agentSlug, e.payload.path, e.payload.actual]),
    ).toEqual([['methods-officer', 'adapterConfig.dangerouslySkipPermissions', true]]);
  });

  it('detects the approval flag being unset (Paperclip defaults it to bypass)', async () => {
    const w = compliantWorld();
    delete (w.agents[2].adapterConfig as Rec).dangerouslySkipPermissions;
    const h = harness(w);
    await runDriftCheck(h.deps);
    expect(actionable(h.published)[0].payload).toMatchObject({
      agentSlug: 'engineer',
      path: 'adapterConfig.dangerouslySkipPermissions',
      actual: 'unset (defaults to true)',
    });
  });

  it('detects an extra grant', async () => {
    const w = compliantWorld();
    w.grants[ENG] = [{ permissionKey: 'tools:admin', scope: null }];
    const h = harness(w);
    await runDriftCheck(h.deps);
    expect(actionable(h.published).map((e) => e.payload)).toEqual([
      expect.objectContaining({
        agentSlug: 'engineer',
        path: 'grants.tools:admin',
        reason: 'extra grant',
      }),
    ]);
  });

  it('detects an unknown agent (e.g. hired without a PR)', async () => {
    const w = compliantWorld();
    w.agents.push({
      ...w.agents[2],
      id: '99999999-9999-4999-8999-999999999999',
      name: 'Shadow hire',
    });
    const h = harness(w);
    await runDriftCheck(h.deps);
    expect(actionable(h.published).map((e) => e.payload)).toEqual([
      expect.objectContaining({
        status: 'unknown_agent',
        agentId: '99999999-9999-4999-8999-999999999999',
      }),
    ]);
  });

  it('detects the company hiring gate switched off (the real staging state today)', async () => {
    const w = compliantWorld();
    w.company.requireBoardApprovalForNewAgents = false;
    const h = harness(w);
    await runDriftCheck(h.deps);
    expect(actionable(h.published).map((e) => e.payload.path)).toEqual([
      'company.requireBoardApprovalForNewAgents',
    ]);
  });

  it('never publishes or logs a secret value, even with a planted credential everywhere', async () => {
    const w = compliantWorld();
    (w.agents[2].permissions as Rec).canCreateAgents = true;
    (w.agents[0].adapterConfig as Rec).model = PLANTED_SECRET; // drifted field carrying a secret
    (w.agents[1].adapterConfig as Rec).extraArgs = [
      '--api-key',
      PLANTED_SECRET,
      '--dangerously-skip-permissions',
    ];
    w.grants[ENG] = [{ permissionKey: 'tasks:assign', scope: { token: PLANTED_SECRET } }];
    const h = harness(w);
    await runDriftCheck(h.deps);
    const everything = JSON.stringify(h.published) + JSON.stringify(h.logs);
    expect(everything).not.toContain('PLANTED-SECRET');
    expect(everything).toContain('--dangerously-skip-permissions'); // the bypass flag itself is reported
  });

  it('fails closed and alerts when agents-authz.json is invalid', async () => {
    const h = harness(compliantWorld(), {
      loadConfig: () => {
        throw new AgentsAuthzLoadError('agents-authz.json is invalid: agents.ceo.owner: Required');
      },
    });
    const res = await runDriftCheck(h.deps);
    expect(res.ok).toBe(false);
    expect(res.fatal).toContain('invalid');
    expect(driftEvents(h.published)).toEqual([]);
    expect(String(chatEvents(h.published)[0].payload.text)).toContain('INCONNU');
    expect(h.logs.some((l) => l.msg.startsWith(JOB_FAILURE_MARKER))).toBe(true);
  });

  it('fails closed when Paperclip cannot be read', async () => {
    const w = compliantWorld();
    w.paperclip.agents.list = async () => {
      throw new Error('ECONNREFUSED');
    };
    const h = harness(w);
    const res = await runDriftCheck(h.deps);
    expect(res.fatal).toContain('ECONNREFUSED');
    expect(h.logs.some((l) => l.msg.startsWith(JOB_FAILURE_MARKER))).toBe(true);
  });

  it('reports grants as unverifiable when the grants read is refused', async () => {
    const w = compliantWorld();
    w.paperclip.authorization.grants.list = async () => {
      throw new Error('capability authorization.grants.read denied');
    };
    const h = harness(w);
    await runDriftCheck(h.deps);
    expect(
      driftEvents(h.published)
        .filter((e) => e.payload.path === 'grants')
        .map((e) => e.payload.status),
    ).toEqual(['unverifiable', 'unverifiable', 'unverifiable']);
  });

  it('still runs and logs when EVT is not configured, and says so', async () => {
    const w = compliantWorld();
    (w.agents[2].permissions as Rec).canCreateAgents = true;
    const h = harness(w, { evt: undefined });
    const res = await runDriftCheck(h.deps);
    expect(res.ok).toBe(false);
    expect(h.logs.some((l) => l.level === 'warn' && l.msg.includes('EVT is not configured'))).toBe(
      true,
    );
    expect(h.logs.some((l) => l.msg.startsWith(JOB_FAILURE_MARKER))).toBe(true);
  });

  it('has no write path: the fake exposes only reads and none is mutated', async () => {
    const w = compliantWorld();
    const before = JSON.stringify([w.agents, w.grants, w.company]);
    await runDriftCheck(harness(w).deps);
    expect(JSON.stringify([w.agents, w.grants, w.company])).toBe(before);
    expect(w.writes).not.toHaveBeenCalled();
  });
});
