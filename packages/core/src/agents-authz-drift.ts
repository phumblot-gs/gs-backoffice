import {
  effectiveAgents,
  type AgentsAuthz,
  type ConnectorState,
  type EffectiveAgent,
  type EnvironmentName,
  type Grant,
} from './agents-authz.js';
import {
  KNOWN_BYPASS_SEQUENCES,
  concreteApproval,
  containsArgSequence,
} from './agents-authz-mapping.js';

/**
 * Drift detection — PURE comparison between agents-authz.json and an observed
 * Paperclip state. Read-only by construction: it never sees a client, only data.
 *
 * Secret hygiene: the observed state carries only allow-listed, non-secret fields
 * (no adapterConfig.env, no raw extraArgs — only the parsed --allowedTools list and
 * whether a bypass flag is present). Reported values are additionally scrubbed by
 * `safeValue` as defence in depth.
 */

/** A field the collector could read, or explicitly could not. Never conflate the two. */
export type Observed<T> = { observable: true; value: T } | { observable: false; reason: string };

export const observed = <T>(value: T): Observed<T> => ({ observable: true, value });
export const unobservable = <T = never>(reason: string): Observed<T> => ({
  observable: false,
  reason,
});

export interface ObservedAgent {
  id: string;
  name: string;
  role: string;
  status: string;
  adapterType: string;
  canCreateAgents: Observed<boolean>;
  canCreateSkills: Observed<boolean>;
  canAssignTasks: Observed<boolean>;
  /** Effective trust preset; Paperclip treats unset as `standard`. */
  trustPreset: Observed<string>;
  trustBoundary: Observed<Record<string, unknown> | null>;
  grants: Observed<Grant[]>;
  connectors: Observed<Record<string, ConnectorState>>;
  runsIn: Observed<'host' | 'sandbox'>;
  model: Observed<string | null>;
  /** Allow-listed approval-related adapterConfig fields (undefined = unset). */
  approvalFields: Observed<Record<string, unknown>>;
  /** Parsed `--allowedTools` list from extraArgs (null = flag absent). */
  allowedTools: Observed<string[] | null>;
  /** Raw extraArgs are NOT carried; only the known bypass sequences found in them
   *  (each joined with a space, e.g. "--permission-mode bypassPermissions"). */
  bypassFlags: Observed<string[]>;
  /** NAMES of adapterConfig.env entries holding a plaintext value — never the values. */
  plaintextEnvNames: Observed<string[]>;
}

export interface ObservedState {
  environment: EnvironmentName;
  companyId: string;
  company: { requireBoardApprovalForNewAgents: Observed<boolean> };
  instance: {
    runnerApiToolsEnabled: Observed<boolean>;
    experimentalFlags: Observed<Record<string, boolean>>;
  };
  agents: ObservedAgent[];
}

export type DriftStatus = 'ok' | 'drift' | 'unverifiable' | 'unknown_agent' | 'missing_agent';

export interface DriftFinding {
  environment: EnvironmentName;
  /** null for company / instance level findings and for unknown agents. */
  agentSlug: string | null;
  agentId?: string;
  path: string;
  status: DriftStatus;
  expected?: unknown;
  actual?: unknown;
  reason?: string;
}

const SECRET_PATTERN =
  /(sk-ant-|ghp_|github_pat_|gs_(staging|production)_|-----BEGIN|xox[abp]-|AKIA[0-9A-Z]{12})/;

/** Defence in depth: never let something that looks like a credential into a report. */
export function safeValue(v: unknown): unknown {
  if (typeof v === 'string') {
    if (SECRET_PATTERN.test(v)) return '<redacted>';
    return v.length > 200 ? `${v.slice(0, 200)}…` : v;
  }
  if (Array.isArray(v)) return v.map(safeValue);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, safeValue(x)]));
  }
  return v;
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

const grantKey = (g: Grant): string => `${g.key}|${canonical(g.scope ?? null)}`;

export function compareAuthz(config: AgentsAuthz, state: ObservedState): DriftFinding[] {
  const env = state.environment;
  const findings: DriftFinding[] = [];
  const push = (f: Omit<DriftFinding, 'environment'>) =>
    findings.push({
      environment: env,
      ...f,
      ...(f.expected !== undefined ? { expected: safeValue(f.expected) } : {}),
      ...(f.actual !== undefined ? { actual: safeValue(f.actual) } : {}),
    });

  /** Compare one scalar/structured field, honouring observability. */
  const field = <T>(
    agentSlug: string | null,
    agentId: string | undefined,
    path: string,
    expected: T,
    obs: Observed<T>,
    equals: (a: T, b: T) => boolean = (a, b) => canonical(a) === canonical(b),
  ) => {
    if (!obs.observable) {
      push({ agentSlug, agentId, path, status: 'unverifiable', expected, reason: obs.reason });
    } else if (equals(expected, obs.value)) {
      push({ agentSlug, agentId, path, status: 'ok' });
    } else {
      push({ agentSlug, agentId, path, status: 'drift', expected, actual: obs.value });
    }
  };

  // --- Company / instance ---------------------------------------------------------
  const section = config.environments[env];
  if (section.companyId && section.companyId !== state.companyId) {
    push({
      agentSlug: null,
      path: 'environments.companyId',
      status: 'drift',
      expected: section.companyId,
      actual: state.companyId,
    });
  }
  field(
    null,
    undefined,
    'company.requireBoardApprovalForNewAgents',
    config.company.requireBoardApprovalForNewAgents,
    state.company.requireBoardApprovalForNewAgents,
  );
  field(
    null,
    undefined,
    'instance.runnerApiToolsEnabled',
    config.instance.runnerApiToolsEnabled,
    state.instance.runnerApiToolsEnabled,
  );
  for (const flag of config.instance.experimentalFlagsOff) {
    const flags = state.instance.experimentalFlags;
    const obs: Observed<boolean> = flags.observable
      ? observed(flags.value[flag] === true)
      : unobservable(flags.reason);
    field(null, undefined, `instance.experimental.${flag}`, false, obs);
  }

  // --- Agents ---------------------------------------------------------------------
  const expectedAgents = effectiveAgents(config, env);
  const bySlugId = new Map(expectedAgents.map((a) => [a.paperclipAgentId?.toLowerCase(), a]));
  const live = state.agents.filter((a) => a.status !== 'terminated');

  for (const a of live) {
    if (!bySlugId.has(a.id.toLowerCase())) {
      push({
        agentSlug: null,
        agentId: a.id,
        path: 'agents',
        status: 'unknown_agent',
        actual: { id: a.id, name: a.name, role: a.role, adapterType: a.adapterType },
        reason: 'agent exists in Paperclip but is not declared in agents-authz.json',
      });
    }
  }

  const liveById = new Map(live.map((a) => [a.id.toLowerCase(), a]));
  for (const exp of expectedAgents) {
    if (!exp.paperclipAgentId) {
      push({
        agentSlug: exp.slug,
        path: 'agents',
        status: 'missing_agent',
        reason: `no Paperclip agent id mapped for ${env}`,
      });
      continue;
    }
    const obs = liveById.get(exp.paperclipAgentId.toLowerCase());
    if (!obs) {
      push({
        agentSlug: exp.slug,
        agentId: exp.paperclipAgentId,
        path: 'agents',
        status: 'missing_agent',
        reason: 'declared in agents-authz.json but not found (or terminated) in Paperclip',
      });
      continue;
    }
    compareAgent(exp, obs, field, push);
  }
  return findings;
}

type FieldFn = <T>(
  agentSlug: string | null,
  agentId: string | undefined,
  path: string,
  expected: T,
  obs: Observed<T>,
  equals?: (a: T, b: T) => boolean,
) => void;

function compareAgent(
  exp: EffectiveAgent,
  obs: ObservedAgent,
  field: FieldFn,
  push: (f: Omit<DriftFinding, 'environment'>) => void,
): void {
  const s = exp.slug;
  const id = obs.id;
  const p = exp.resolvedProfile;

  field(s, id, 'adapter.type', exp.adapter.type, observed(obs.adapterType));
  if (exp.adapter.model !== undefined) {
    field<string | null>(s, id, 'adapter.model', exp.adapter.model, obs.model);
  }
  field(s, id, 'permissions.canCreateAgents', exp.canCreateAgents, obs.canCreateAgents);
  field(s, id, 'permissions.canCreateSkills', exp.canCreateSkills, obs.canCreateSkills);
  field(s, id, 'access.canAssignTasks', exp.canAssignTasks, obs.canAssignTasks);
  field(s, id, 'permissions.trustPreset', p.trustPreset as string, obs.trustPreset);
  field<Record<string, unknown> | null>(
    s,
    id,
    'permissions.authorizationPolicy.trustBoundary',
    (exp.trustBoundary as Record<string, unknown> | undefined) ?? null,
    obs.trustBoundary,
  );
  field(s, id, 'runsIn', p.runsIn, obs.runsIn);

  // Grants — set comparison, one finding per extra / missing grant.
  if (!obs.grants.observable) {
    push({
      agentSlug: s,
      agentId: id,
      path: 'grants',
      status: 'unverifiable',
      expected: exp.grants,
      reason: obs.grants.reason,
    });
  } else {
    const want = new Map(exp.grants.map((g) => [grantKey(g), g]));
    const have = new Map(obs.grants.value.map((g) => [grantKey(g), g]));
    let clean = true;
    for (const [k, g] of have) {
      if (!want.has(k)) {
        clean = false;
        push({
          agentSlug: s,
          agentId: id,
          path: `grants.${g.key}`,
          status: 'drift',
          expected: null,
          actual: g,
          reason: 'extra grant',
        });
      }
    }
    for (const [k, g] of want) {
      if (!have.has(k)) {
        clean = false;
        push({
          agentSlug: s,
          agentId: id,
          path: `grants.${g.key}`,
          status: 'drift',
          expected: g,
          actual: null,
          reason: 'missing grant',
        });
      }
    }
    if (clean) push({ agentSlug: s, agentId: id, path: 'grants', status: 'ok' });
  }

  // Connector actions — every declared action, plus any observed action not declared.
  if (!obs.connectors.observable) {
    if (Object.keys(exp.connectors).length > 0) {
      push({
        agentSlug: s,
        agentId: id,
        path: 'connectors',
        status: 'unverifiable',
        expected: exp.connectors,
        reason: obs.connectors.reason,
      });
    } else {
      push({
        agentSlug: s,
        agentId: id,
        path: 'connectors',
        status: 'unverifiable',
        expected: {},
        reason: obs.connectors.reason,
      });
    }
  } else {
    const have = obs.connectors.value;
    for (const [action, c] of Object.entries(exp.connectors)) {
      field(s, id, `connectors.${action}`, c.state as string, observed(have[action] ?? 'off'));
    }
    for (const [action, state] of Object.entries(have)) {
      if (!(action in exp.connectors) && state !== 'off') {
        push({
          agentSlug: s,
          agentId: id,
          path: `connectors.${action}`,
          status: 'drift',
          expected: 'off',
          actual: state,
          reason: 'undeclared connector action',
        });
      }
    }
  }

  // Approval mode → concrete adapter fields via the mapping table.
  const concrete = concreteApproval(obs.adapterType, p.approvalMode);
  if (!concrete) {
    push({
      agentSlug: s,
      agentId: id,
      path: 'approvalMode',
      status: 'unverifiable',
      expected: p.approvalMode,
      reason: `no verified approval mapping for adapter "${obs.adapterType}"`,
    });
  } else if (!obs.approvalFields.observable) {
    push({
      agentSlug: s,
      agentId: id,
      path: 'approvalMode',
      status: 'unverifiable',
      expected: p.approvalMode,
      reason: obs.approvalFields.reason,
    });
  } else {
    for (const [k, want] of Object.entries(concrete.adapterConfig)) {
      const raw = obs.approvalFields.value[k];
      const effective = raw === undefined ? concrete.defaultsWhenUnset[k] : raw;
      if (canonical(effective) === canonical(want)) {
        push({ agentSlug: s, agentId: id, path: `adapterConfig.${k}`, status: 'ok' });
      } else {
        push({
          agentSlug: s,
          agentId: id,
          path: `adapterConfig.${k}`,
          status: 'drift',
          expected: want,
          actual: raw === undefined ? `unset (defaults to ${JSON.stringify(effective)})` : raw,
          reason: `approvalMode ${p.approvalMode}`,
        });
      }
    }
    if (!obs.bypassFlags.observable) {
      push({
        agentSlug: s,
        agentId: id,
        path: 'adapterConfig.extraArgs',
        status: 'unverifiable',
        reason: obs.bypassFlags.reason,
      });
    } else {
      const forbidden = new Set(concrete.forbiddenArgSequences.map((seq) => seq.join(' ')));
      const hits = obs.bypassFlags.value.filter((f) => forbidden.has(f));
      if (hits.length > 0) {
        push({
          agentSlug: s,
          agentId: id,
          path: 'adapterConfig.extraArgs',
          status: 'drift',
          expected: 'no permission-bypass flag',
          actual: hits,
          reason: `approvalMode ${p.approvalMode}`,
        });
      } else {
        push({ agentSlug: s, agentId: id, path: 'adapterConfig.extraArgs', status: 'ok' });
      }
    }
  }

  // Plaintext env values: only explicitly allow-listed, non-secret names may be plain.
  if (!obs.plaintextEnvNames.observable) {
    push({
      agentSlug: s,
      agentId: id,
      path: 'adapterConfig.env',
      status: 'unverifiable',
      reason: obs.plaintextEnvNames.reason,
    });
  } else {
    const allowed = new Set(exp.adapter.plainEnvAllowed ?? []);
    const offending = obs.plaintextEnvNames.value.filter((n) => !allowed.has(n)).sort();
    for (const name of offending) {
      push({
        agentSlug: s,
        agentId: id,
        path: `adapterConfig.env.${name}`,
        status: 'drift',
        expected: 'secret reference',
        actual: 'plaintext value',
        reason: 'plaintext env value (stored in the database and returned by GET /api/agents)',
      });
    }
    if (offending.length === 0)
      push({ agentSlug: s, agentId: id, path: 'adapterConfig.env', status: 'ok' });
  }

  if (exp.adapter.allowedTools !== undefined) {
    field<string[] | null>(
      s,
      id,
      'adapter.allowedTools',
      exp.adapter.allowedTools,
      obs.allowedTools,
      (a, b) =>
        canonical([...(a ?? [])].sort()) === canonical([...(b ?? [])].sort()) &&
        (a === null) === (b === null),
    );
  }
}

/**
 * Bypass-flag scan for a raw extraArgs list: returns ONLY the known bypass sequences it
 * contains, so the observed state never carries an arbitrary (possibly secret) argument.
 */
export function bypassFlagsIn(extraArgs: readonly string[]): string[] {
  return KNOWN_BYPASS_SEQUENCES.filter((seq) => containsArgSequence(extraArgs, seq)).map((seq) =>
    seq.join(' '),
  );
}

/** Parse `--allowedTools` from claude_local extraArgs (space- or comma-separated). */
export function parseAllowedTools(extraArgs: readonly string[]): string[] | null {
  const i = extraArgs.findIndex((a) => a === '--allowedTools' || a === '--allowed-tools');
  if (i === -1 || i + 1 >= extraArgs.length) return null;
  return extraArgs[i + 1]
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

export interface DriftSummary {
  environment: EnvironmentName;
  counts: Record<DriftStatus, number>;
  problems: DriftFinding[];
}

/** Everything that is not `ok` is a problem to report: drift AND unverifiable. */
export function summarizeDrift(
  environment: EnvironmentName,
  findings: DriftFinding[],
): DriftSummary {
  const counts: Record<DriftStatus, number> = {
    ok: 0,
    drift: 0,
    unverifiable: 0,
    unknown_agent: 0,
    missing_agent: 0,
  };
  for (const f of findings) counts[f.status]++;
  return { environment, counts, problems: findings.filter((f) => f.status !== 'ok') };
}

/** Google Chat text (French, like the other notifications). No secret values. */
export function formatDriftChatMessage(summary: DriftSummary, maxLines = 15): string {
  const { counts } = summary;
  const actionable = summary.problems.filter((f) => f.status !== 'unverifiable');
  const head =
    actionable.length === 0
      ? `✅ Autorisations agents (${summary.environment}) : aucun écart. ${counts.unverifiable} point(s) non vérifiable(s).`
      : `🚨 Autorisations agents (${summary.environment}) : ${counts.drift} écart(s), ` +
        `${counts.unknown_agent} agent(s) inconnu(s), ${counts.missing_agent} agent(s) manquant(s), ` +
        `${counts.unverifiable} non vérifiable(s).`;
  const lines = actionable.slice(0, maxLines).map((f) => {
    const who = f.agentSlug ?? (f.agentId ? `agent ${f.agentId}` : 'company');
    const detail =
      f.status === 'drift'
        ? `attendu ${JSON.stringify(f.expected)}, constaté ${JSON.stringify(f.actual)}`
        : (f.reason ?? f.status);
    return `• [${f.status}] ${who} — ${f.path} : ${detail}`;
  });
  const more =
    actionable.length > maxLines ? [`… et ${actionable.length - maxLines} autre(s).`] : [];
  return [
    head,
    ...lines,
    ...more,
    'Source de vérité : config/agents-authz.json — voir docs/architecture/agents-authz.md',
  ].join('\n');
}
