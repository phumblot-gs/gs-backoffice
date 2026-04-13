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
    // Dev mode: no real user identity yet (OAuth not implemented)
    // Grant all permissions until OAuth provides real employee identity
    if (userId === 'dev-user' || !this.jumpcloud) {
      logger.warn({ userId }, 'No authenticated user — granting all permissions (dev mode)');
      return {
        userId,
        userEmail,
        groups: ['*'],
        permissions: ['*'],
      };
    }

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
  }
}
