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

// --- Legacy global (single-company) shape -------------------------------------
export const RBACConfigSchema = z.object({
  groups: z.record(z.string(), RBACGroupConfigSchema),
});

export type RBACConfig = z.infer<typeof RBACConfigSchema>;

// --- Per-company (multi-tenant) shape -----------------------------------------
export const CompanyConfigSchema = z.object({
  name: z.string().optional(),
  groups: z.record(z.string(), RBACGroupConfigSchema),
});

export type CompanyConfig = z.infer<typeof CompanyConfigSchema>;

export const PerCompanyRBACConfigSchema = z.object({
  companies: z.record(z.string(), CompanyConfigSchema),
});

export type PerCompanyRBACConfig = z.infer<typeof PerCompanyRBACConfigSchema>;

export interface ResolvedAccess {
  /** Flat permission strings, e.g. "notion.read". */
  permissions: string[];
  /** Per-service scopes, e.g. { notion: ["Finance"], paperclip: ["finance"] }. */
  scopes: Record<string, string[]>;
  /** Allowed routine names (official processes). */
  workflows: string[];
  /** Allowed expert-agent shortnames. */
  agents: string[];
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
  if (!company) return { permissions: [], scopes: {}, workflows: [], agents: [] };
  return accumulateGroups(company.groups, groups);
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
