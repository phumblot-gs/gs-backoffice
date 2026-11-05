import {
  bypassFlagsIn,
  observed,
  parseAllowedTools,
  unobservable,
  type EnvironmentName,
  type Grant,
  type Observed,
  type ObservedAgent,
  type ObservedState,
  type PermissionKey,
} from '@gs-backoffice/core';

/**
 * Builds the observed state from Paperclip through the plugin SDK — READ calls only.
 * Every field the SDK does not expose in 2026.824.1 is returned as `unobservable` with
 * the reason, so the comparison reports it as `unverifiable` instead of assuming it.
 */

/** The subset of the plugin context the collector needs (all reads). */
export interface ReadOnlyPaperclip {
  companies: { get(companyId: string): Promise<Record<string, unknown> | null> };
  agents: {
    list(input: {
      companyId: string;
      limit?: number;
      offset?: number;
    }): Promise<Array<Record<string, unknown>>>;
  };
  authorization: {
    grants: {
      list(input: {
        companyId: string;
        principalType?: 'user' | 'agent';
        principalId?: string;
      }): Promise<Array<{ permissionKey: string; scope?: Record<string, unknown> | null }>>;
    };
  };
}

/** Facts no plugin capability exposes in 2026.824.1 — stated once, reported per field. */
export const UNOBSERVABLE = {
  connectors:
    'no plugin capability exposes tool-connection action states (Allowed / Ask first / Off) in Paperclip 2026.824.1',
  runsIn:
    'environment drivers are not readable by plugins in 2026.824.1 (agent defaultEnvironmentId → driver)',
  canAssignTasks:
    'Paperclip derives canAssignTasks (simple_default / agent_creator) and does not expose the result to plugins in 2026.824.1; only an explicit tasks:assign grant or the ceo role is observable',
  runnerApiTools:
    'plugin workers receive a curated env; PAPERCLIP_RUNNER_API_TOOLS_ENABLED is enforced statically in CI (scripts/check-agents-authz.ts) instead',
  experimentalFlags: 'instance settings are not readable by plugins in 2026.824.1',
} as const;

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

const boolField = (v: unknown, what: string): Observed<boolean> =>
  typeof v === 'boolean' ? observed(v) : unobservable(`${what} not present on the agent record`);

/** Keep only the trust-boundary keys our schema models (drops host-added companyId…). */
const BOUNDARY_KEYS = [
  'mode',
  'projectIds',
  'rootIssueId',
  'issueIds',
  'allowedAgentIds',
  'allowedSecretBindingIds',
  'allowedToolClasses',
] as const;

export function observeAgent(
  agent: Record<string, unknown>,
  grants: Observed<Grant[]>,
): ObservedAgent {
  const permissions = asRecord(agent.permissions);
  const policy = asRecord(permissions?.authorizationPolicy);
  const adapterConfig = asRecord(agent.adapterConfig);
  const rawArgs = adapterConfig?.extraArgs;
  const extraArgs =
    Array.isArray(rawArgs) && rawArgs.every((a) => typeof a === 'string')
      ? (rawArgs as string[])
      : [];
  const boundary = asRecord(policy?.trustBoundary);

  let canAssignTasks: Observed<boolean> = unobservable(UNOBSERVABLE.canAssignTasks);
  if (grants.observable && grants.value.some((g) => g.key === 'tasks:assign'))
    canAssignTasks = observed(true);
  else if (agent.role === 'ceo') canAssignTasks = observed(true); // taskAssignSource "ceo_role"

  return {
    id: String(agent.id),
    name: String(agent.name ?? ''),
    role: String(agent.role ?? ''),
    status: String(agent.status ?? ''),
    adapterType: String(agent.adapterType ?? ''),
    canCreateAgents: permissions
      ? boolField(permissions.canCreateAgents, 'permissions.canCreateAgents')
      : unobservable('permissions not present on the agent record'),
    canCreateSkills: permissions
      ? boolField(permissions.canCreateSkills, 'permissions.canCreateSkills')
      : unobservable('permissions not present on the agent record'),
    canAssignTasks,
    // Paperclip treats an unset preset as `standard`.
    trustPreset: permissions
      ? observed(String(permissions.trustPreset ?? policy?.trustPreset ?? 'standard'))
      : unobservable('permissions not present on the agent record'),
    trustBoundary: permissions
      ? observed(
          boundary
            ? Object.fromEntries(
                BOUNDARY_KEYS.filter((k) => boundary[k] !== undefined).map((k) => [k, boundary[k]]),
              )
            : null,
        )
      : unobservable('permissions not present on the agent record'),
    grants,
    connectors: unobservable(UNOBSERVABLE.connectors),
    runsIn: unobservable(UNOBSERVABLE.runsIn),
    model: adapterConfig
      ? observed(typeof adapterConfig.model === 'string' ? adapterConfig.model : null)
      : unobservable('adapterConfig not present on the agent record'),
    // Allow-list: ONLY approval-related keys leave this function. Never adapterConfig.env.
    approvalFields: adapterConfig
      ? observed({ dangerouslySkipPermissions: adapterConfig.dangerouslySkipPermissions })
      : unobservable('adapterConfig not present on the agent record'),
    allowedTools: adapterConfig
      ? observed(parseAllowedTools(extraArgs))
      : unobservable('adapterConfig not present on the agent record'),
    bypassFlags: adapterConfig
      ? observed(bypassFlagsIn(extraArgs))
      : unobservable('adapterConfig not present on the agent record'),
    plaintextEnvNames: adapterConfig
      ? observed(plaintextEnvNames(adapterConfig.env))
      : unobservable('adapterConfig not present on the agent record'),
  };
}

/**
 * Names of env entries bound to a plaintext value (a bare string or `{type:'plain'}`),
 * per Paperclip's EnvBinding. Secret references are fine. Values never leave here.
 */
export function plaintextEnvNames(env: unknown): string[] {
  const rec = asRecord(env);
  if (!rec) return [];
  return Object.entries(rec)
    .filter(([, b]) => typeof b === 'string' || asRecord(b)?.type === 'plain')
    .map(([name]) => name)
    .sort();
}

async function listAllAgents(
  pc: ReadOnlyPaperclip,
  companyId: string,
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  const limit = 100;
  for (let offset = 0; offset < 10_000; offset += limit) {
    const page = await pc.agents.list({ companyId, limit, offset });
    out.push(...page);
    if (page.length < limit) break;
  }
  return out;
}

export async function collectObservedState(
  pc: ReadOnlyPaperclip,
  companyId: string,
  environment: EnvironmentName,
): Promise<ObservedState> {
  const company = await pc.companies.get(companyId);
  if (!company) throw new Error(`company ${companyId} not visible to the plugin`);
  const agents = await listAllAgents(pc, companyId);

  const observedAgents: ObservedAgent[] = [];
  for (const a of agents) {
    let grants: Observed<Grant[]>;
    try {
      const raw = await pc.authorization.grants.list({
        companyId,
        principalType: 'agent',
        principalId: String(a.id),
      });
      grants = observed(
        raw.map((g) => ({ key: g.permissionKey as PermissionKey, scope: g.scope ?? null })),
      );
    } catch (err) {
      grants = unobservable(
        `grants could not be read: ${String((err as Error).message ?? err).slice(0, 160)}`,
      );
    }
    observedAgents.push(observeAgent(a, grants));
  }

  return {
    environment,
    companyId,
    company: {
      requireBoardApprovalForNewAgents: boolField(
        company.requireBoardApprovalForNewAgents,
        'company.requireBoardApprovalForNewAgents',
      ),
    },
    instance: {
      runnerApiToolsEnabled: unobservable(UNOBSERVABLE.runnerApiTools),
      experimentalFlags: unobservable(UNOBSERVABLE.experimentalFlags),
    },
    agents: observedAgents,
  };
}
