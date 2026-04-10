import type { RBACConfig, DataSourcePermissions } from '@gs-backoffice/core';
import { JumpCloudClient } from '@gs-backoffice/jumpcloud-client';
import pino from 'pino';

const logger = pino({ name: 'rbac' });

export interface RBACContext {
  userId: string;
  groups: string[];
  allowedAgents: string[];
  dataSources: Record<string, DataSourcePermissions>;
}

export class RBACResolver {
  private readonly jumpcloud: JumpCloudClient | null;
  private readonly rbacConfig: RBACConfig;

  constructor(jumpcloud: JumpCloudClient | null, rbacConfig: RBACConfig) {
    this.jumpcloud = jumpcloud;
    this.rbacConfig = rbacConfig;
  }

  async resolve(userId: string): Promise<RBACContext> {
    // In dev mode without JumpCloud, grant all permissions
    if (!this.jumpcloud) {
      logger.warn({ userId }, 'No JumpCloud client — granting all permissions (dev mode)');
      const allAgents = new Set<string>();
      const allDataSources: Record<string, DataSourcePermissions> = {};
      for (const group of Object.values(this.rbacConfig.groups)) {
        for (const agent of group.agents) allAgents.add(agent);
        for (const [k, v] of Object.entries(group.dataSources)) {
          allDataSources[k] = v;
        }
      }
      return {
        userId,
        groups: ['*'],
        allowedAgents: [...allAgents],
        dataSources: allDataSources,
      };
    }

    const perms = await this.jumpcloud.resolvePermissions(userId, this.rbacConfig);
    logger.info(
      { userId, groups: perms.groups.map((g) => g.name), agents: perms.allowedAgents },
      'RBAC resolved',
    );
    return {
      userId,
      groups: perms.groups.map((g) => g.name),
      allowedAgents: perms.allowedAgents,
      dataSources: perms.dataSources,
    };
  }
}
