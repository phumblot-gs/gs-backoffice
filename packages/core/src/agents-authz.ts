import { readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * Agent authorizations as code — `config/agents-authz.json`.
 *
 * Paperclip has no deny layer and no instance-wide switch to constrain agents, and
 * recent releases ship permissive defaults. Git is therefore the source of truth for
 * what each agent MAY do, and a read-only drift job compares Paperclip's real state
 * with this file (see docs/architecture/agents-authz.md).
 *
 * Field names follow Paperclip 2026.824.1 as verified against the live OpenAPI spec
 * and the staging inventory — not the names used in early drafts:
 *   - company hiring gate: `requireBoardApprovalForNewAgents` (not "...ForHires")
 *   - trust boundary: `permissions.authorizationPolicy.trustBoundary`, mode-tagged
 *   - grant `scope`: an undocumented, opaque JSON object (`{ additionalProperties }`)
 */

// --- Paperclip vocabularies (2026.824.1) ----------------------------------------

/** The 21 permission keys accepted by `PATCH /members/:id/permissions` (OpenAPI enum). */
export const PAPERCLIP_PERMISSION_KEYS = [
  'agents:create',
  'agents:configure',
  'agents:suggest-changes',
  'skills:create',
  'skills:suggest-changes',
  'environments:manage',
  'tools:admin',
  'tools:manage_connections',
  'tools:manage_profiles',
  'tools:view_audit',
  'audit:view_agent_actions',
  'tools:use',
  'tools:manage_runtime',
  'inbox:manage',
  'users:invite',
  'users:manage_permissions',
  'tasks:assign',
  'tasks:assign_scope',
  'tasks:manage_active_checkouts',
  'pipelines:write',
  'joins:approve',
] as const;
export const PermissionKeySchema = z.enum(PAPERCLIP_PERMISSION_KEYS);
export type PermissionKey = z.infer<typeof PermissionKeySchema>;

export const TrustPresetSchema = z.enum(['standard', 'low_trust_review']);
export type TrustPreset = z.infer<typeof TrustPresetSchema>;

/** Connector (tool connection) action state, as Paperclip names it. */
export const ConnectorStateSchema = z.enum(['allowed', 'ask_first', 'off']);
export type ConnectorState = z.infer<typeof ConnectorStateSchema>;

// --- Our abstractions -----------------------------------------------------------

/**
 * Abstract approval mode. Mapped per adapter by APPROVAL_MODE_MAP
 * (agents-authz-mapping.ts) so adapter-specific flags never leak into agent entries.
 */
export const ApprovalModeSchema = z.enum(['restricted', 'read_only', 'full_auto']);
export type ApprovalMode = z.infer<typeof ApprovalModeSchema>;

/**
 * Where the agent's harness process runs. `host` = inside the Paperclip container
 * (claude_local today). `sandbox` = a Paperclip environment with the `sandbox` driver.
 * NOTE: our Engineer / Methods Officer run on the HOST and only *call* the Fly Sprites
 * sandbox tools — the coding happens in the sandbox, the agent harness does not.
 */
export const RunsInSchema = z.enum(['host', 'sandbox']);
export type RunsIn = z.infer<typeof RunsInSchema>;

const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), 'invalid calendar date');

const UuidSchema = z.string().uuid();

/** Mirrors Paperclip's strict `lowTrustBoundarySchema` (2026.824.1). */
export const TrustBoundarySchema = z
  .object({
    mode: z.literal('low_trust_review'),
    projectIds: z.array(UuidSchema).optional(),
    rootIssueId: UuidSchema.optional(),
    issueIds: z.array(UuidSchema).optional(),
    allowedAgentIds: z.array(UuidSchema).optional(),
    allowedSecretBindingIds: z.array(UuidSchema).optional(),
    allowedToolClasses: z.array(z.string().trim().min(1)).optional(),
  })
  .strict();
export type TrustBoundary = z.infer<typeof TrustBoundarySchema>;

export const ProfileSchema = z
  .object({
    trustPreset: TrustPresetSchema,
    runsIn: RunsInSchema,
    approvalMode: ApprovalModeSchema,
    description: z.string().optional(),
  })
  .strict();
export type Profile = z.infer<typeof ProfileSchema>;

/**
 * An explicit permission grant. `scope` is OPAQUE: Paperclip types it as an arbitrary
 * JSON object and documents no selector syntax, so we store it verbatim and compare it
 * structurally. `null`/absent = company-wide.
 */
export const GrantSchema = z
  .object({
    key: PermissionKeySchema,
    scope: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .strict();
export type Grant = z.infer<typeof GrantSchema>;

export const ConnectorActionSchema = z
  .object({
    state: ConnectorStateSchema,
    /** True when the action sends data outside the company (email, chat, post…). */
    externalSend: z.boolean(),
  })
  .strict();
export type ConnectorAction = z.infer<typeof ConnectorActionSchema>;

/** Adapter-level expectations. Only allow-listed, non-secret fields are modelled. */
export const AdapterSchema = z
  .object({
    type: z.string().min(1),
    model: z.string().min(1).optional(),
    /** claude_local: the exact `--allowedTools` list passed in `extraArgs`. */
    allowedTools: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type Adapter = z.infer<typeof AdapterSchema>;

/**
 * Explicit, justified exception allowing `canCreateAgents=true` for ONE agent. Hires it
 * proposes still need board approval: the rules require
 * `company.requireBoardApprovalForNewAgents=true` whenever an exception exists. It is
 * governance metadata, so an environment override cannot add or change it.
 */
export const HiringExceptionSchema = z
  .object({
    justification: z.string().trim().min(10),
    approvedBy: z.array(z.string().trim().min(1)).min(1),
    approvedAt: IsoDateSchema,
  })
  .strict();
export type HiringException = z.infer<typeof HiringExceptionSchema>;

const AgentFieldsSchema = z.object({
  profile: z.string().min(1),
  canCreateAgents: z.boolean(),
  canCreateSkills: z.boolean(),
  canAssignTasks: z.boolean(),
  grants: z.array(GrantSchema),
  connectors: z.record(z.string().min(1), ConnectorActionSchema),
  adapter: AdapterSchema,
  trustBoundary: TrustBoundarySchema.optional(),
  hiringException: HiringExceptionSchema.optional(),
  owner: z.string().trim().min(1),
  justification: z.string().trim().min(10),
  reviewedAt: IsoDateSchema,
});

export const AgentSchema = AgentFieldsSchema.strict();
export type AgentAuthz = z.infer<typeof AgentSchema>;

/** Per-environment override: any agent field except governance metadata (incl. hiringException). */
export const AgentOverrideSchema = AgentFieldsSchema.omit({
  hiringException: true,
  owner: true,
  justification: true,
  reviewedAt: true,
})
  .partial()
  .strict();
export type AgentOverride = z.infer<typeof AgentOverrideSchema>;

export const EnvironmentNameSchema = z.enum(['staging', 'production']);
export type EnvironmentName = z.infer<typeof EnvironmentNameSchema>;

export const EnvironmentSectionSchema = z
  .object({
    /** Paperclip company id of this environment (identifier, not a secret). Optional:
     *  when absent, the drift job checks the single company the plugin is configured on. */
    companyId: UuidSchema.optional(),
    /** slug → Paperclip agent UUID, read from Paperclip (never guessed). */
    agentIds: z.record(z.string().min(1), UuidSchema),
    overrides: z.record(z.string().min(1), AgentOverrideSchema).default({}),
  })
  .strict();
export type EnvironmentSection = z.infer<typeof EnvironmentSectionSchema>;

export const AgentsAuthzSchema = z
  .object({
    version: z.literal(1),
    company: z
      .object({
        requireBoardApprovalForNewAgents: z.boolean(),
      })
      .strict(),
    instance: z
      .object({
        /** Expected value of PAPERCLIP_RUNNER_API_TOOLS_ENABLED ("anything but true" ⇒ off). */
        runnerApiToolsEnabled: z.boolean(),
        /** Instance experimental flags that must be OFF (absent in a version ⇒ compliant). */
        experimentalFlagsOff: z.array(z.string().min(1)),
      })
      .strict(),
    profiles: z.record(z.string().min(1), ProfileSchema),
    agents: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/, 'slug: kebab-case'), AgentSchema),
    environments: z
      .object({
        staging: EnvironmentSectionSchema,
        production: EnvironmentSectionSchema,
      })
      .strict(),
  })
  .strict();
export type AgentsAuthz = z.infer<typeof AgentsAuthzSchema>;

/** An agent with its environment override applied and its profile resolved. */
export interface EffectiveAgent extends AgentAuthz {
  slug: string;
  paperclipAgentId: string | undefined;
  resolvedProfile: Profile;
}

export class AgentsAuthzLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentsAuthzLoadError';
  }
}

/** Parse + schema-validate. Throws AgentsAuthzLoadError (fail-closed) — never defaults. */
export function parseAgentsAuthz(raw: unknown): AgentsAuthz {
  const res = AgentsAuthzSchema.safeParse(raw);
  if (!res.success) {
    const issues = res.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new AgentsAuthzLoadError(`agents-authz.json is invalid: ${issues}`);
  }
  return res.data;
}

/**
 * Load the file from disk. FAIL-CLOSED: a missing, unreadable, non-JSON or invalid file
 * throws — callers (drift job, CI check) must refuse to proceed and raise an alert,
 * never fall back to an empty or permissive policy.
 */
export function loadAgentsAuthz(path: string): AgentsAuthz {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new AgentsAuthzLoadError(`cannot read ${path}: ${(err as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new AgentsAuthzLoadError(`${path} is not valid JSON: ${(err as Error).message}`);
  }
  return parseAgentsAuthz(json);
}

/** Resolve every agent for one environment (override merged, profile looked up). */
export function effectiveAgents(config: AgentsAuthz, env: EnvironmentName): EffectiveAgent[] {
  const section = config.environments[env];
  return Object.entries(config.agents).map(([slug, base]) => {
    const merged: AgentAuthz = { ...base, ...(section.overrides[slug] ?? {}) };
    const resolvedProfile = config.profiles[merged.profile];
    if (!resolvedProfile) {
      throw new AgentsAuthzLoadError(
        `agent "${slug}" references unknown profile "${merged.profile}"`,
      );
    }
    return { ...merged, slug, paperclipAgentId: section.agentIds[slug], resolvedProfile };
  });
}
