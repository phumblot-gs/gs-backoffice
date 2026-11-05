import {
  effectiveAgents,
  type AgentsAuthz,
  type EffectiveAgent,
  type EnvironmentName,
} from './agents-authz.js';

/**
 * Policy rules for config/agents-authz.json, run in CI (hard failures) on top of the
 * schema. Each rule is evaluated on the EFFECTIVE agent of BOTH environments, so a
 * per-environment override cannot sneak a forbidden setting past review.
 */

export interface AuthzRuleViolation {
  rule: string;
  environment?: EnvironmentName;
  agent?: string;
  message: string;
}

export interface AuthzRuleReport {
  errors: AuthzRuleViolation[];
  warnings: AuthzRuleViolation[];
}

/** Quarterly access review: warn at 100 days, fail at 120. */
export const REVIEW_WARN_DAYS = 100;
export const REVIEW_FAIL_DAYS = 120;

/**
 * Permission keys that let an agent create or hire agents. Never allowed as a grant: the
 * only sanctioned path is the `canCreateAgents` switch backed by an explicit
 * `hiringException`, with board approval of hires switched on.
 */
const HIRING_KEYS = new Set(['agents:create']);

/**
 * Connector action names that send data outside the company. Any action matching this
 * MUST be declared `externalSend: true`, so the flag cannot be used to hide a send.
 */
export const EXTERNAL_SEND_ACTION_RE =
  /(^|[._-])(send|reply|forward|post|publish|share|invite|email|message|notify|upload|create_draft_and_send)($|[._-])/i;

const ENVIRONMENTS: EnvironmentName[] = ['staging', 'production'];

function daysBetween(fromIso: string, today: Date): number {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.floor((to - from) / 86_400_000);
}

function checkAgent(
  agent: EffectiveAgent,
  env: EnvironmentName,
  push: (v: AuthzRuleViolation) => void,
): void {
  const base = { environment: env, agent: agent.slug };
  const p = agent.resolvedProfile;

  if (agent.canCreateAgents && !agent.hiringException) {
    push({
      ...base,
      rule: 'no-hiring',
      message:
        'canCreateAgents=true requires an explicit hiringException (justification, approvedBy)',
    });
  }
  for (const g of agent.grants) {
    if (HIRING_KEYS.has(g.key)) {
      push({ ...base, rule: 'no-hiring', message: `grant "${g.key}" is forbidden for agents` });
    }
  }
  const keys = agent.grants.map((g) => `${g.key}|${JSON.stringify(g.scope ?? null)}`);
  if (new Set(keys).size !== keys.length) {
    push({ ...base, rule: 'unique-grants', message: 'duplicate grant (same key and scope)' });
  }

  if (p.trustPreset === 'low_trust_review') {
    const b = agent.trustBoundary;
    const hasScope =
      !!b && (!!b.rootIssueId || (b.projectIds?.length ?? 0) > 0 || (b.issueIds?.length ?? 0) > 0);
    if (!hasScope) {
      push({
        ...base,
        rule: 'low-trust-boundary',
        message:
          'low_trust_review requires a trustBoundary with rootIssueId, projectIds or issueIds',
      });
    }
  } else if (agent.trustBoundary) {
    push({
      ...base,
      rule: 'low-trust-boundary',
      message: 'trustBoundary is only meaningful with trustPreset low_trust_review',
    });
  }

  for (const [action, c] of Object.entries(agent.connectors)) {
    if (EXTERNAL_SEND_ACTION_RE.test(action) && !c.externalSend) {
      push({
        ...base,
        rule: 'external-send',
        message: `connector "${action}" looks like an external send and must be marked externalSend: true`,
      });
    }
    if (c.externalSend && c.state === 'allowed') {
      push({
        ...base,
        rule: 'external-send',
        message: `connector "${action}" sends externally and must be ask_first or off, never allowed`,
      });
    }
  }
}

export function validateAgentsAuthzRules(
  config: AgentsAuthz,
  today: Date = new Date(),
): AuthzRuleReport {
  const errors: AuthzRuleViolation[] = [];
  const warnings: AuthzRuleViolation[] = [];

  if (config.company.requireBoardApprovalForNewAgents !== true) {
    errors.push({
      rule: 'board-approval-for-hires',
      message: 'company.requireBoardApprovalForNewAgents must be true',
    });
  }
  if (config.instance.runnerApiToolsEnabled) {
    errors.push({
      rule: 'runner-api-tools-off',
      message: 'instance.runnerApiToolsEnabled must be false (search_api / call_api / hire_agent)',
    });
  }

  // Profiles are checked on their own, so a forbidden profile fails even while unused.
  for (const [name, p] of Object.entries(config.profiles)) {
    if (p.runsIn === 'host' && p.approvalMode === 'full_auto') {
      errors.push({
        rule: 'host-not-full-auto',
        message: `profile "${name}" runs on the host and cannot be full_auto (full_auto is sandbox-only)`,
      });
    }
    if (p.trustPreset === 'low_trust_review' && p.runsIn !== 'sandbox') {
      errors.push({
        rule: 'low-trust-sandbox',
        message: `profile "${name}": low_trust_review requires runsIn: sandbox (Paperclip fails closed otherwise)`,
      });
    }
  }

  for (const [slug, agent] of Object.entries(config.agents)) {
    if (agent.hiringException && config.company.requireBoardApprovalForNewAgents !== true) {
      errors.push({
        rule: 'no-hiring',
        agent: slug,
        message:
          'a hiringException requires company.requireBoardApprovalForNewAgents=true (hires stay board-approved)',
      });
    }
    if (!config.profiles[agent.profile]) {
      errors.push({
        rule: 'known-profile',
        agent: slug,
        message: `unknown profile "${agent.profile}"`,
      });
    }
    const age = daysBetween(agent.reviewedAt, today);
    if (age < 0) {
      errors.push({
        rule: 'review-date',
        agent: slug,
        message: `reviewedAt ${agent.reviewedAt} is in the future`,
      });
    } else if (age > REVIEW_FAIL_DAYS) {
      errors.push({
        rule: 'review-date',
        agent: slug,
        message: `reviewedAt is ${age} days old (> ${REVIEW_FAIL_DAYS}): quarterly access review overdue`,
      });
    } else if (age > REVIEW_WARN_DAYS) {
      warnings.push({
        rule: 'review-date',
        agent: slug,
        message: `reviewedAt is ${age} days old (> ${REVIEW_WARN_DAYS}): access review due soon`,
      });
    }
  }
  for (const [env, section] of Object.entries(config.environments) as Array<
    [EnvironmentName, AgentsAuthz['environments'][EnvironmentName]]
  >) {
    for (const [slug, o] of Object.entries(section.overrides)) {
      if (o.profile !== undefined && !config.profiles[o.profile]) {
        errors.push({
          rule: 'known-profile',
          environment: env,
          agent: slug,
          message: `unknown profile "${o.profile}"`,
        });
      }
    }
    for (const slug of [...Object.keys(section.agentIds), ...Object.keys(section.overrides)]) {
      if (!config.agents[slug]) {
        errors.push({
          rule: 'known-agent',
          environment: env,
          agent: slug,
          message: 'slug not declared under agents',
        });
      }
    }
    const seen = new Map<string, string>();
    for (const [slug, id] of Object.entries(section.agentIds)) {
      const prev = seen.get(id.toLowerCase());
      if (prev) {
        errors.push({
          rule: 'unique-agent-id',
          environment: env,
          agent: slug,
          message: `Paperclip id ${id} is already mapped to "${prev}"`,
        });
      }
      seen.set(id.toLowerCase(), slug);
    }
  }
  if (errors.some((e) => e.rule === 'known-profile' || e.rule === 'known-agent')) {
    return { errors, warnings };
  }

  for (const env of ENVIRONMENTS) {
    for (const agent of effectiveAgents(config, env)) {
      checkAgent(agent, env, (v) => errors.push(v));
    }
  }
  return { errors, warnings };
}
