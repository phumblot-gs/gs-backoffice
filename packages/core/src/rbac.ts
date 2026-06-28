import { z } from 'zod';

export const ServicePermissionSchema = z.object({
  actions: z.array(z.string()),
  scopes: z.array(z.string()).optional(),
});

export type ServicePermission = z.infer<typeof ServicePermissionSchema>;

export const RBACGroupConfigSchema = z.object({
  services: z.record(z.string(), ServicePermissionSchema),
  // Expert-agent access (Capability C): agent shortnames this group may interact with.
  agents: z.array(z.string()).optional(),
  // Allowed official-process routines (Capability B).
  workflows: z.array(z.string()).optional(),
});

export type RBACGroupConfig = z.infer<typeof RBACGroupConfigSchema>;

// Per-process metadata for the approval gate (Capability 2b). `scope` routes a
// sensitive process to the right approvers: a user may approve it if they hold
// `paperclip.approve` AND a `paperclip` scope of `*` or this exact scope.
// `scope: null` makes it leadership-only (same as having no catalog entry) — used
// to declare a leadership-reserved process explicitly, for auditability.
export const ProcessConfigSchema = z.object({
  scope: z.string().nullable(),
});

export type ProcessConfig = z.infer<typeof ProcessConfigSchema>;

// --- Legacy global (single-company) shape -------------------------------------
export const RBACConfigSchema = z.object({
  groups: z.record(z.string(), RBACGroupConfigSchema),
});

export type RBACConfig = z.infer<typeof RBACConfigSchema>;

// --- Per-company (multi-tenant) shape -----------------------------------------
export const CompanyConfigSchema = z.object({
  name: z.string().optional(),
  groups: z.record(z.string(), RBACGroupConfigSchema),
  // Catalog mapping official-process codes to an approval scope (Capability 2b).
  processes: z.record(z.string(), ProcessConfigSchema).optional(),
});

export type CompanyConfig = z.infer<typeof CompanyConfigSchema>;

export const PerCompanyRBACConfigSchema = z.object({
  companies: z.record(z.string(), CompanyConfigSchema),
  // Maps a GitHub repo ("owner/repo") to the notification SCOPE used for routing
  // (e.g. PR-review notifications). The scope then selects the Google Chat channel
  // via GOOGLE_CHAT_WEBHOOKS (the notify-consumer falls back to "general"). A repo
  // not listed here ⇒ "general". Lets ops route per-repo channels without code.
  repos: z.record(z.string(), z.string()).optional(),
});

export type PerCompanyRBACConfig = z.infer<typeof PerCompanyRBACConfigSchema>;

/**
 * The notification scope for a repo ("owner/repo"), used to route Google Chat
 * notifications (e.g. a PR awaiting review). Defaults to "general" when the repo is
 * not mapped. The scope is lowercased to match the notify-consumer's channel keys.
 */
export function notifyScopeForRepo(config: PerCompanyRBACConfig, repo: string): string {
  const scope = config.repos?.[repo.trim()];
  return (scope && scope.trim() ? scope : 'general').toLowerCase();
}

export interface ResolvedAccess {
  /** Flat permission strings, e.g. "notion.read". */
  permissions: string[];
  /** Per-service scopes, e.g. { notion: ["Finance"], paperclip: ["finance"] }. */
  scopes: Record<string, string[]>;
  /** Allowed routine names (official processes). */
  workflows: string[];
  /** Allowed expert-agent shortnames. */
  agents: string[];
  /** Company process→approval-scope catalog (company-level, not user-specific). */
  processes?: Record<string, ProcessConfig>;
}

/**
 * Whether a resolved user may approve a sensitive process of the given scope.
 * Requires the `paperclip.approve` permission AND a `paperclip` scope covering
 * the process: `*` (leadership) approves anything; a scoped approver approves
 * only its own scope; an unscoped process (`scope === null`) is leadership-only.
 */
export function canApprove(access: ResolvedAccess, scope: string | null): boolean {
  if (access.permissions.includes('*')) return true; // superuser / dev
  if (!access.permissions.includes('paperclip.approve')) return false;
  const paperclipScopes = access.scopes['paperclip'] ?? access.scopes['*'] ?? [];
  if (paperclipScopes.includes('*')) return true;
  return scope !== null && paperclipScopes.includes(scope);
}

/**
 * Whether a resolved user may manage budgets (create/adjust policies, resolve
 * incidents). Reserved to leadership (Management Team + Comex) via the
 * `paperclip.budget` permission. Superusers (`*`) always pass.
 */
export function canManageBudget(access: ResolvedAccess): boolean {
  if (access.permissions.includes('*')) return true; // superuser / dev
  return access.permissions.includes('paperclip.budget');
}

/**
 * Accumulate the UNION of permissions / scopes / workflows / agents over the
 * intersection of `userGroups` and the configured groups.
 */
function accumulateGroups(
  groupsConfig: Record<string, RBACGroupConfig>,
  userGroups: string[],
): ResolvedAccess {
  const permissions = new Set<string>();
  const scopes: Record<string, string[]> = {};
  const workflows = new Set<string>();
  const agents = new Set<string>();

  for (const groupName of userGroups) {
    const group = groupsConfig[groupName];
    if (!group) continue;

    for (const [service, perm] of Object.entries(group.services)) {
      for (const action of perm.actions) {
        permissions.add(`${service}.${action}`);
      }
      if (perm.scopes) {
        if (!scopes[service]) scopes[service] = [];
        for (const scope of perm.scopes) {
          if (!scopes[service].includes(scope)) {
            scopes[service].push(scope);
          }
        }
      }
    }

    for (const wf of group.workflows ?? []) workflows.add(wf);
    for (const agent of group.agents ?? []) agents.add(agent);
  }

  return {
    permissions: [...permissions],
    scopes,
    workflows: [...workflows],
    agents: [...agents],
  };
}

/**
 * Resolve access from the legacy global (single-company) config.
 * Each permission is formatted as "service.action" (e.g., "notion.read").
 */
export function resolvePermissions(config: RBACConfig, groups: string[]): ResolvedAccess {
  return accumulateGroups(config.groups, groups);
}

/**
 * Resolve a user's effective access on a specific company (multi-tenant).
 * Effective access = UNION over (userGroups ∩ the company's authorized groups).
 * Fail-closed: an unknown company or no matching group ⇒ empty access (no tools).
 */
export function resolveCompanyAccess(
  config: PerCompanyRBACConfig,
  companyKey: string,
  groups: string[],
): ResolvedAccess {
  const company = config.companies[companyKey];
  if (!company) return { permissions: [], scopes: {}, workflows: [], agents: [], processes: {} };
  return { ...accumulateGroups(company.groups, groups), processes: company.processes ?? {} };
}

/**
 * List the companies a user can access = those whose authorized groups intersect
 * the user's groups.
 */
export function resolveAccessibleCompanies(
  config: PerCompanyRBACConfig,
  groups: string[],
): string[] {
  return Object.entries(config.companies)
    .filter(([, company]) => Object.keys(company.groups).some((g) => groups.includes(g)))
    .map(([key]) => key);
}
