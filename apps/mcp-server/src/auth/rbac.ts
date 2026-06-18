import { type PerCompanyRBACConfig, resolveCompanyAccess } from '@gs-backoffice/core';
import { JumpCloudClient } from '@gs-backoffice/jumpcloud-client';
import pino from 'pino';
import type { ToolContext } from '../plugins/types.js';

const logger = pino({ name: 'rbac' });

export class RBACResolver {
  private readonly jumpcloud: JumpCloudClient | null;
  private readonly rbacConfig: PerCompanyRBACConfig;
  private readonly companySlug: string;

  constructor(
    jumpcloud: JumpCloudClient | null,
    rbacConfig: PerCompanyRBACConfig,
    companySlug: string,
  ) {
    this.jumpcloud = jumpcloud;
    this.rbacConfig = rbacConfig;
    this.companySlug = companySlug;
  }

  /**
   * Fail-closed context: the user is authenticated but gets NO permissions and
   * NO scopes, so the plugin manager exposes zero tools to them.
   */
  private denyAll(userId: string, userEmail: string): ToolContext {
    return {
      userId,
      userEmail,
      groups: [],
      permissions: [],
      scopes: {},
      workflows: [],
      agents: [],
    };
  }

  async resolve(userId: string, userEmail: string): Promise<ToolContext> {
    if (userId === 'dev-user' || !this.jumpcloud) {
      logger.warn({ userId, userEmail }, 'Dev mode — granting all permissions');
      return {
        userId,
        userEmail,
        groups: ['*'],
        permissions: ['*'],
        scopes: { '*': ['*'] },
        workflows: ['*'],
        agents: ['*'],
      };
    }

    try {
      // Look up user by email in JumpCloud (Google email may differ from JumpCloud email)
      const result = await this.jumpcloud.getUserGroupsByEmail(userEmail);

      if (!result) {
        // Fail-closed: an authenticated user with no JumpCloud identity gets no access.
        logger.warn({ userEmail }, 'User not found in JumpCloud — denying all access');
        return this.denyAll(userId, userEmail);
      }

      const groupNames = result.groups.map((g) => g.name);
      const resolved = resolveCompanyAccess(this.rbacConfig, this.companySlug, groupNames);

      logger.info(
        {
          userId,
          userEmail,
          jcUser: result.user.username,
          company: this.companySlug,
          groups: groupNames,
          permissions: resolved.permissions,
        },
        resolved.permissions.length > 0
          ? 'RBAC resolved'
          : 'RBAC resolved — no access on this company (denying)',
      );

      return {
        userId,
        userEmail,
        groups: groupNames,
        permissions: resolved.permissions,
        scopes: resolved.scopes,
        workflows: resolved.workflows,
        agents: resolved.agents,
        processes: resolved.processes,
      };
    } catch (err) {
      // Fail-closed: if we cannot verify the user's groups, deny rather than grant.
      logger.error(
        { userId, userEmail, error: err },
        'JumpCloud lookup failed — denying all access (fail-closed)',
      );
      return this.denyAll(userId, userEmail);
    }
  }
}
