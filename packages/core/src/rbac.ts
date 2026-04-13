import { z } from 'zod';

export const ServicePermissionSchema = z.object({
  actions: z.array(z.string()),
  scopes: z.array(z.string()).optional(),
});

export type ServicePermission = z.infer<typeof ServicePermissionSchema>;

export const RBACGroupConfigSchema = z.object({
  services: z.record(z.string(), ServicePermissionSchema),
  workflows: z.array(z.string()),
});

export type RBACGroupConfig = z.infer<typeof RBACGroupConfigSchema>;

export const RBACConfigSchema = z.object({
  groups: z.record(z.string(), RBACGroupConfigSchema),
});

export type RBACConfig = z.infer<typeof RBACConfigSchema>;

/**
 * Resolve flat permission strings from a list of group names.
 * Each permission is formatted as "service.action" (e.g., "notion.read").
 * Scopes are tracked separately.
 */
export function resolvePermissions(
  config: RBACConfig,
  groups: string[],
): { permissions: string[]; scopes: Record<string, string[]>; workflows: string[] } {
  const permissions = new Set<string>();
  const scopes: Record<string, string[]> = {};
  const workflows = new Set<string>();

  for (const groupName of groups) {
    const group = config.groups[groupName];
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

    for (const wf of group.workflows) {
      workflows.add(wf);
    }
  }

  return {
    permissions: [...permissions],
    scopes,
    workflows: [...workflows],
  };
}
