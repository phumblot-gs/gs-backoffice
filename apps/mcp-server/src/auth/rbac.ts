import { type RBACConfig, resolvePermissions } from '@gs-backoffice/core';
import { JumpCloudClient } from '@gs-backoffice/jumpcloud-client';
import pino from 'pino';
import type { ToolContext } from '../plugins/types.js';

const logger = pino({ name: 'rbac' });

export class RBACResolver {
  private readonly jumpcloud: JumpCloudClient | null;
  private readonly rbacConfig: RBACConfig;

  constructor(jumpcloud: JumpCloudClient | null, rbacConfig: RBACConfig) {
    this.jumpcloud = jumpcloud;
    this.rbacConfig = rbacConfig;
  }

  async resolve(userId: string, userEmail: string): Promise<ToolContext> {
    // Dev mode: grant all permissions
    if (userId === 'dev-user' || !this.jumpcloud) {
      logger.warn({ userId, userEmail }, 'Dev mode — granting all permissions');
      return {
        userId,
        userEmail,
        groups: ['*'],
        permissions: ['*'],
      };
    }

    try {
      const userGroups = await this.jumpcloud.getUserGroups(userId);
      const groupNames = userGroups.map((g) => g.name);
      const resolved = resolvePermissions(this.rbacConfig, groupNames);

      logger.info(
        { userId, userEmail, groups: groupNames, permissions: resolved.permissions },
        'RBAC resolved',
      );

      return {
        userId,
        userEmail,
        groups: groupNames,
        permissions: resolved.permissions,
      };
    } catch (err) {
      logger.warn(
        { userId, userEmail, error: err },
        'JumpCloud lookup failed — granting all permissions as fallback',
      );
      return {
        userId,
        userEmail,
        groups: ['*'],
        permissions: ['*'],
      };
    }
  }
}
