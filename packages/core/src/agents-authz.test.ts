import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AgentsAuthzLoadError,
  effectiveAgents,
  loadAgentsAuthz,
  parseAgentsAuthz,
  type AgentsAuthz,
} from './agents-authz.js';
import {
  APPROVAL_MODE_MAP,
  concreteApproval,
  containsArgSequence,
} from './agents-authz-mapping.js';
import { validateAgentsAuthzRules } from './agents-authz-rules.js';
import {
  bypassFlagsIn,
  compareAuthz,
  formatDriftChatMessage,
  observed,
  parseAllowedTools,
  safeValue,
  summarizeDrift,
  unobservable,
  type ObservedAgent,
  type ObservedState,
} from './agents-authz-drift.js';

const FIXTURES = fileURLToPath(new URL('./__fixtures__/agents-authz/', import.meta.url));
const SHIPPED = fileURLToPath(new URL('../../../config/agents-authz.json', import.meta.url));
const TODAY = new Date('2026-11-05T12:00:00Z');

const fixture = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
const load = (name: string): AgentsAuthz => parseAgentsAuthz(fixture(name));
const rulesOf = (name: string) => validateAgentsAuthzRules(load(name), TODAY);

describe('agents-authz schema + loader (fail-closed)', () => {
  it('loads the valid fixture', () => {
    expect(() => load('valid.json')).not.toThrow();
  });

  it('throws on a missing file — never falls back to an empty policy', () => {
    expect(() => loadAgentsAuthz('/nonexistent/agents-authz.json')).toThrow(AgentsAuthzLoadError);
  });

  it('throws on non-JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'authz-'));
    writeFileSync(join(dir, 'a.json'), '{ not json');
    expect(() => loadAgentsAuthz(join(dir, 'a.json'))).toThrow(/not valid JSON/);
  });

  it('rejects a missing owner', () => {
    expect(() => load('missing-owner.json')).toThrow(/owner/);
  });

  it('rejects an invented permission key', () => {
    expect(() => load('unknown-permission-key.json')).toThrow(AgentsAuthzLoadError);
  });

  it('rejects unknown top-level fields (strict)', () => {
    const raw = { ...(fixture('valid.json') as object), extra: true };
    expect(() => parseAgentsAuthz(raw)).toThrow(/extra|Unrecognized/);
  });

  it('applies per-environment overrides on top of the common agent', () => {
    const cfg = load('valid.json');
    cfg.environments.production.overrides['chief-of-staff'] = { canAssignTasks: false };
    const prod = effectiveAgents(cfg, 'production').find((a) => a.slug === 'chief-of-staff')!;
    const stg = effectiveAgents(cfg, 'staging').find((a) => a.slug === 'chief-of-staff')!;
    expect(prod.canAssignTasks).toBe(false);
    expect(stg.canAssignTasks).toBe(true);
    expect(stg.paperclipAgentId).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  });
});

describe('the shipped config/agents-authz.json', () => {
  it('loads and passes every CI rule', () => {
    const cfg = loadAgentsAuthz(SHIPPED);
    const report = validateAgentsAuthzRules(cfg);
    expect(report.errors).toEqual([]);
  });

  it('declares owner, justification and reviewedAt for every agent', () => {
    const cfg = loadAgentsAuthz(SHIPPED);
    for (const a of Object.values(cfg.agents)) {
      expect(a.owner).toBeTruthy();
      expect(a.justification.length).toBeGreaterThan(10);
      expect(a.reviewedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('contains no credential-looking value', () => {
    const text = readFileSync(SHIPPED, 'utf8');
    expect(text).not.toMatch(/sk-ant-|ghp_|github_pat_|gs_(staging|production)_|BEGIN .*KEY/);
  });
});

describe('CI rules', () => {
  it('passes on the valid fixture', () => {
    expect(rulesOf('valid.json').errors).toEqual([]);
  });

  // Negative fixtures — like the cross-tenant RBAC tests: each proves one forbidden posture fails.
  it.each([
    ['business-full-auto.json', 'host-not-full-auto'],
    ['business-can-hire.json', 'no-hiring'],
    ['business-hiring-grant.json', 'no-hiring'],
    ['override-sneaks-hiring.json', 'no-hiring'],
    ['business-sends-without-approval.json', 'external-send'],
    ['send-not-flagged.json', 'external-send'],
    ['low-trust-on-host.json', 'low-trust-sandbox'],
    ['low-trust-without-scope.json', 'low-trust-boundary'],
    ['hires-without-board-approval.json', 'board-approval-for-hires'],
    ['duplicate-agent-id.json', 'unique-agent-id'],
    ['stale-review.json', 'review-date'],
  ])('%s fails with rule %s', (file, rule) => {
    const { errors } = rulesOf(file);
    expect(errors.map((e) => e.rule)).toContain(rule);
  });

  it('allows canCreateAgents with an explicit hiringException', () => {
    expect(rulesOf('hiring-exception.json').errors).toEqual([]);
  });

  it('a hiringException requires board approval of hires', () => {
    expect(rulesOf('hiring-exception-without-board-approval.json').errors).toContainEqual(
      expect.objectContaining({ rule: 'no-hiring', agent: 'chief-of-staff' }),
    );
  });

  it('a hiringException cannot be added through an environment override', () => {
    expect(() => load('hiring-exception-in-override.json')).toThrow(/hiringException|Unrecognized/);
  });

  it('an agents:create grant stays forbidden even with a hiringException', () => {
    const cfg = load('hiring-exception.json');
    cfg.agents['chief-of-staff'].grants.push({ key: 'agents:create' });
    expect(validateAgentsAuthzRules(cfg, TODAY).errors.map((e) => e.rule)).toContain('no-hiring');
  });

  it('a production-only override that enables hiring is caught in production', () => {
    const { errors } = rulesOf('override-sneaks-hiring.json');
    expect(errors).toContainEqual(
      expect.objectContaining({
        rule: 'no-hiring',
        environment: 'production',
        agent: 'chief-of-staff',
      }),
    );
    expect(errors.some((e) => e.environment === 'staging')).toBe(false);
  });

  it('warns between 100 and 120 days, fails beyond', () => {
    const cfg = load('valid.json');
    cfg.agents['chief-of-staff'].reviewedAt = '2026-07-20'; // 108 days before TODAY
    const r = validateAgentsAuthzRules(cfg, TODAY);
    expect(r.errors.filter((e) => e.rule === 'review-date')).toEqual([]);
    expect(r.warnings.map((w) => w.rule)).toContain('review-date');
    cfg.agents['chief-of-staff'].reviewedAt = '2026-07-01'; // 127 days
    expect(validateAgentsAuthzRules(cfg, TODAY).errors.map((e) => e.rule)).toContain('review-date');
  });

  it('rejects a slug mapped in an environment but not declared', () => {
    const cfg = load('valid.json');
    cfg.environments.staging.agentIds['ghost'] = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    expect(validateAgentsAuthzRules(cfg, TODAY).errors.map((e) => e.rule)).toContain('known-agent');
  });

  it('refuses to allow a credential-like env name in plaintext', () => {
    const cfg = load('valid.json');
    cfg.agents['chief-of-staff'].adapter.plainEnvAllowed = ['ANTHROPIC_API_KEY'];
    expect(validateAgentsAuthzRules(cfg, TODAY).errors.map((e) => e.rule)).toContain(
      'no-plaintext-secret-env',
    );
  });

  it('rejects a malformed plugin tool name', () => {
    const raw = fixture('valid.json') as { agents: Record<string, { pluginTools: string[] }> };
    raw.agents['chief-of-staff'].pluginTools = ['sandbox_run'];
    expect(() => parseAgentsAuthz(raw)).toThrow(/pluginTools/);
  });

  it('requires a bridge sandbox tool and its plugin tool to be allowed together', () => {
    const SB = 'gs-backoffice.fly-sprites-sandbox-provider:';
    const harnessOnly = load('valid.json');
    harnessOnly.agents['chief-of-staff'].adapter.allowedTools = ['mcp__gs-sandbox__sandbox_run'];
    expect(validateAgentsAuthzRules(harnessOnly, TODAY).errors).toContainEqual(
      expect.objectContaining({
        rule: 'plugin-tools-match-bridge',
        message: expect.stringContaining('gateway would deny'),
      }),
    );
    const gatewayOnly = load('valid.json');
    gatewayOnly.agents['chief-of-staff'].pluginTools = [`${SB}sandbox_code_task`];
    expect(validateAgentsAuthzRules(gatewayOnly, TODAY).errors).toContainEqual(
      expect.objectContaining({
        rule: 'plugin-tools-match-bridge',
        message: expect.stringContaining('unused gateway access'),
      }),
    );
    const both = load('valid.json');
    both.agents['chief-of-staff'].adapter.allowedTools = ['mcp__gs-sandbox__sandbox_release'];
    both.agents['chief-of-staff'].pluginTools = [`${SB}sandbox_release`];
    expect(validateAgentsAuthzRules(both, TODAY).errors).toEqual([]);
  });

  it('rejects enabling the runner API tools', () => {
    const cfg = load('valid.json');
    cfg.instance.runnerApiToolsEnabled = true;
    expect(validateAgentsAuthzRules(cfg, TODAY).errors.map((e) => e.rule)).toContain(
      'runner-api-tools-off',
    );
  });
});

describe('approval-mode mapping table', () => {
  it('maps claude_local modes to dangerouslySkipPermissions and the CLI engine', () => {
    expect(concreteApproval('claude_local', 'restricted')?.adapterConfig).toEqual({
      dangerouslySkipPermissions: false,
      engine: 'cli',
    });
    expect(concreteApproval('claude_local', 'read_only')?.adapterConfig).toEqual({
      dangerouslySkipPermissions: false,
      engine: 'cli',
    });
    expect(concreteApproval('claude_local', 'full_auto')?.adapterConfig).toEqual({
      dangerouslySkipPermissions: true,
    });
  });

  it('judges unset claude_local fields by Paperclip’s permissive defaults', () => {
    expect(concreteApproval('claude_local', 'restricted')?.defaultsWhenUnset).toEqual({
      dangerouslySkipPermissions: true,
      engine: 'auto',
    });
  });

  it('forbids bypass flags in extraArgs for every non-full_auto mode', () => {
    for (const mode of ['restricted', 'read_only'] as const) {
      const seqs = concreteApproval('claude_local', mode)!.forbiddenArgSequences;
      expect(
        seqs.some((s) => containsArgSequence(['--permission-mode', 'bypassPermissions'], s)),
      ).toBe(true);
      expect(seqs.some((s) => containsArgSequence(['--dangerously-skip-permissions'], s))).toBe(
        true,
      );
    }
  });

  it('returns null (unverifiable) for adapters whose approval key is not verified', () => {
    expect(concreteApproval('codex_local', 'restricted')).toBeNull();
    expect(concreteApproval('opencode_local', 'full_auto')).toBeNull();
    expect(concreteApproval('some_future_adapter', 'restricted')).toBeNull();
    expect(APPROVAL_MODE_MAP.codex_local).toBeNull();
  });

  it('matches arg sequences contiguously only', () => {
    expect(
      containsArgSequence(
        ['--permission-mode', 'default', 'bypassPermissions'],
        ['--permission-mode', 'bypassPermissions'],
      ),
    ).toBe(false);
    expect(bypassFlagsIn(['--permission-mode', 'default', 'bypassPermissions'])).toEqual([]);
    expect(bypassFlagsIn(['--x', '--permission-mode', 'bypassPermissions'])).toEqual([
      '--permission-mode bypassPermissions',
    ]);
  });

  it('parses --allowedTools from extraArgs', () => {
    expect(
      parseAllowedTools(['--mcp-config', '/x.json', '--allowedTools', 'Read Grep  mcp__a__b']),
    ).toEqual(['Read', 'Grep', 'mcp__a__b']);
    expect(parseAllowedTools(['--mcp-config', '/x.json'])).toBeNull();
  });
});

// --- Drift ---------------------------------------------------------------------------

const COS_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const VERIFIER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** An observed state that matches valid.json exactly (staging). */
function matchingState(): ObservedState {
  const cos: ObservedAgent = {
    id: COS_ID,
    name: 'Chief of Staff',
    role: 'general',
    status: 'idle',
    adapterType: 'claude_local',
    canCreateAgents: observed(false),
    canCreateSkills: observed(false),
    canAssignTasks: observed(true),
    trustPreset: observed('standard'),
    trustBoundary: observed(null),
    grants: observed([{ key: 'tasks:assign' as const }]),
    connectors: observed({ 'gmail.send': 'ask_first' as const, 'gmail.read': 'allowed' as const }),
    pluginTools: observed([]),
    runsIn: observed('host' as const),
    model: observed('claude-sonnet-4-6'),
    approvalFields: observed({ dangerouslySkipPermissions: false, engine: 'cli' }),
    allowedTools: observed(['Grep', 'Read']),
    bypassFlags: observed([]),
    plaintextEnvNames: observed([]),
  };
  const verifier: ObservedAgent = {
    ...cos,
    id: VERIFIER_ID,
    name: 'Verifier',
    canAssignTasks: observed(false),
    trustPreset: observed('low_trust_review'),
    trustBoundary: observed({
      mode: 'low_trust_review',
      rootIssueId: '11111111-1111-4111-8111-111111111111',
      allowedToolClasses: ['git.read'],
    }),
    grants: observed([]),
    connectors: observed({}),
    runsIn: observed('sandbox' as const),
    model: observed(null),
    allowedTools: observed(null),
  };
  return {
    environment: 'staging',
    companyId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    company: { requireBoardApprovalForNewAgents: observed(true) },
    instance: { runnerApiToolsEnabled: observed(false), experimentalFlags: observed({}) },
    agents: [cos, verifier],
  };
}

const problems = (state: ObservedState) =>
  compareAuthz(load('valid.json'), state).filter((f) => f.status !== 'ok');

describe('drift comparison', () => {
  it('reports nothing when Paperclip matches the file', () => {
    expect(problems(matchingState())).toEqual([]);
  });

  it('detects a changed canCreateAgents', () => {
    const s = matchingState();
    s.agents[0].canCreateAgents = observed(true);
    expect(problems(s)).toEqual([
      expect.objectContaining({
        agentSlug: 'chief-of-staff',
        path: 'permissions.canCreateAgents',
        status: 'drift',
        expected: false,
        actual: true,
      }),
    ]);
  });

  it('detects a switched approval mode, including an unset flag that defaults to bypass', () => {
    const s = matchingState();
    s.agents[0].approvalFields = observed({ dangerouslySkipPermissions: true, engine: 'cli' });
    expect(problems(s)).toContainEqual(
      expect.objectContaining({
        path: 'adapterConfig.dangerouslySkipPermissions',
        status: 'drift',
        actual: true,
      }),
    );
    s.agents[0].approvalFields = observed({ engine: 'cli' });
    expect(problems(s)).toContainEqual(
      expect.objectContaining({
        path: 'adapterConfig.dangerouslySkipPermissions',
        actual: 'unset (defaults to true)',
      }),
    );
  });

  it('flags the ACP engine (unset = auto) on a restricted claude_local agent', () => {
    const s = matchingState();
    s.agents[0].approvalFields = observed({ dangerouslySkipPermissions: false });
    expect(problems(s)).toEqual([
      expect.objectContaining({
        path: 'adapterConfig.engine',
        status: 'drift',
        expected: 'cli',
        actual: 'unset (defaults to "auto")',
      }),
    ]);
    s.agents[0].approvalFields = observed({ dangerouslySkipPermissions: false, engine: 'acp' });
    expect(problems(s)).toContainEqual(
      expect.objectContaining({ path: 'adapterConfig.engine', actual: 'acp' }),
    );
  });

  it('detects a bypass flag smuggled into extraArgs', () => {
    const s = matchingState();
    s.agents[0].bypassFlags = observed(['--dangerously-skip-permissions']);
    expect(problems(s)).toContainEqual(
      expect.objectContaining({ path: 'adapterConfig.extraArgs', status: 'drift' }),
    );
  });

  it('detects an extra grant', () => {
    const s = matchingState();
    s.agents[0].grants = observed([
      { key: 'tasks:assign' as const },
      { key: 'tools:admin' as const },
    ]);
    expect(problems(s)).toEqual([
      expect.objectContaining({
        path: 'grants.tools:admin',
        status: 'drift',
        reason: 'extra grant',
      }),
    ]);
  });

  it('treats a grant with a different (opaque) scope as drift', () => {
    const s = matchingState();
    s.agents[0].grants = observed([{ key: 'tasks:assign' as const, scope: { projectIds: ['x'] } }]);
    const p = problems(s).map((f) => f.reason);
    expect(p).toContain('extra grant');
    expect(p).toContain('missing grant');
  });

  it('detects a plaintext env value, reporting only the variable name', () => {
    const s = matchingState();
    s.agents[0].plaintextEnvNames = observed(['ANTHROPIC_API_KEY']);
    expect(problems(s)).toEqual([
      expect.objectContaining({
        agentSlug: 'chief-of-staff',
        path: 'adapterConfig.env.ANTHROPIC_API_KEY',
        status: 'drift',
        expected: 'secret reference',
        actual: 'plaintext value',
      }),
    ]);
  });

  it('compares plugin tools as an exact set, and says when they cannot be read', () => {
    const SB = 'gs-backoffice.fly-sprites-sandbox-provider:';
    const s = matchingState();
    s.agents[0].pluginTools = observed([`${SB}sandbox_run`]);
    expect(problems(s)).toEqual([
      expect.objectContaining({
        agentSlug: 'chief-of-staff',
        path: 'pluginTools',
        status: 'drift',
        expected: [],
        actual: [`${SB}sandbox_run`],
        reason: `extra: ${SB}sandbox_run`,
      }),
    ]);
    s.agents[0].pluginTools = unobservable('profiles not readable');
    expect(problems(s)).toEqual([
      expect.objectContaining({
        path: 'pluginTools',
        status: 'unverifiable',
        expected: [],
        reason: 'profiles not readable',
      }),
    ]);
  });

  it('accepts a plaintext env name explicitly allowed for the agent', () => {
    const cfg = load('valid.json');
    cfg.agents['chief-of-staff'].adapter.plainEnvAllowed = ['PAPERCLIP_PROJECT_ID'];
    const s = matchingState();
    s.agents[0].plaintextEnvNames = observed(['PAPERCLIP_PROJECT_ID']);
    expect(compareAuthz(cfg, s).filter((f) => f.status !== 'ok')).toEqual([]);
  });

  it('flags an unknown agent and a missing one', () => {
    const s = matchingState();
    s.agents[1] = {
      ...s.agents[1],
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      name: 'Hired by someone',
    };
    const p = problems(s);
    expect(p).toContainEqual(
      expect.objectContaining({
        status: 'unknown_agent',
        agentId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      }),
    );
    expect(p).toContainEqual(
      expect.objectContaining({ status: 'missing_agent', agentSlug: 'verifier' }),
    );
  });

  it('ignores terminated agents', () => {
    const s = matchingState();
    s.agents.push({
      ...s.agents[0],
      id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      status: 'terminated',
    });
    expect(problems(s)).toEqual([]);
  });

  it('reports an unobservable field as unverifiable — never as ok', () => {
    const s = matchingState();
    s.agents[0].canAssignTasks = unobservable('derived by Paperclip; not exposed to plugins');
    s.instance.runnerApiToolsEnabled = unobservable('plugin worker env is curated');
    const p = problems(s);
    expect(p).toContainEqual(
      expect.objectContaining({ path: 'access.canAssignTasks', status: 'unverifiable' }),
    );
    expect(p).toContainEqual(
      expect.objectContaining({ path: 'instance.runnerApiToolsEnabled', status: 'unverifiable' }),
    );
    const all = compareAuthz(load('valid.json'), s);
    expect(
      all.find((f) => f.path === 'access.canAssignTasks' && f.agentSlug === 'chief-of-staff')
        ?.status,
    ).toBe('unverifiable');
  });

  it('reports the approval mode of an unmapped adapter as unverifiable', () => {
    const s = matchingState();
    s.agents[0].adapterType = 'codex_local';
    const p = problems(s);
    expect(p).toContainEqual(
      expect.objectContaining({ path: 'approvalMode', status: 'unverifiable' }),
    );
    expect(p).toContainEqual(expect.objectContaining({ path: 'adapter.type', status: 'drift' }));
  });

  it('detects a connector action opened to allowed, and an undeclared one', () => {
    const s = matchingState();
    s.agents[0].connectors = observed({
      'gmail.send': 'allowed' as const,
      'gmail.read': 'allowed' as const,
      'slack.post': 'ask_first' as const,
    });
    const p = problems(s);
    expect(p).toContainEqual(
      expect.objectContaining({
        path: 'connectors.gmail.send',
        expected: 'ask_first',
        actual: 'allowed',
      }),
    );
    expect(p).toContainEqual(
      expect.objectContaining({
        path: 'connectors.slack.post',
        reason: 'undeclared connector action',
      }),
    );
  });

  it('every production agent is missing until production ids are filled in', () => {
    const s = { ...matchingState(), environment: 'production' as const };
    const p = problems(s);
    expect(
      p
        .filter((f) => f.status === 'missing_agent')
        .map((f) => f.agentSlug)
        .sort(),
    ).toEqual(['chief-of-staff', 'verifier']);
    expect(p.filter((f) => f.status === 'unknown_agent')).toHaveLength(2);
  });

  it('detects the company hiring gate being off', () => {
    const s = matchingState();
    s.company.requireBoardApprovalForNewAgents = observed(false);
    expect(problems(s)).toEqual([
      expect.objectContaining({
        path: 'company.requireBoardApprovalForNewAgents',
        status: 'drift',
        agentSlug: null,
      }),
    ]);
  });

  it('never lets a credential-looking value into findings or the chat message', () => {
    const s = matchingState();
    s.agents[0].model = observed('sk-ant-api03-SECRETSECRET');
    s.agents[0].grants = observed([
      {
        key: 'tasks:assign' as const,
        scope: { token: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' },
      },
    ]);
    const findings = compareAuthz(load('valid.json'), s);
    const text =
      JSON.stringify(findings) + formatDriftChatMessage(summarizeDrift('staging', findings));
    expect(text).not.toMatch(/sk-ant-api03|ghp_abcdef/);
    expect(text).toContain('<redacted>');
    expect(safeValue({ a: ['-----BEGIN RSA PRIVATE KEY-----'] })).toEqual({ a: ['<redacted>'] });
  });

  it('summarises and formats a chat message', () => {
    const s = matchingState();
    s.agents[0].canCreateAgents = observed(true);
    const summary = summarizeDrift('staging', compareAuthz(load('valid.json'), s));
    expect(summary.counts.drift).toBe(1);
    const msg = formatDriftChatMessage(summary);
    expect(msg).toContain('🚨');
    expect(msg).toContain('chief-of-staff — permissions.canCreateAgents');
  });
});
