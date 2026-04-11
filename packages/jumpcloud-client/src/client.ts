import type { RBACConfig, DataSourcePermissions } from '@gs-backoffice/core';
import type { JumpCloudConfig, UserGroup, GroupMember } from './types.js';
import { UserGroupsResponseSchema, GroupMembersResponseSchema } from './types.js';
import { JumpCloudApiError } from './errors.js';

const DEFAULT_BASE_URL = 'https://console.jumpcloud.com/api/v2';
const DEFAULT_TIMEOUT = 10000;
const DEFAULT_RETRIES = 2;

export class JumpCloudClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeout: number;
  private readonly retries: number;

  constructor(config: JumpCloudConfig) {
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT;
    this.retries = config.retries ?? DEFAULT_RETRIES;
  }

  async getUserGroups(userId: string): Promise<UserGroup[]> {
    const data = await this.request(`/users/${userId}/memberof`);
    return UserGroupsResponseSchema.parse(data);
  }

  async getGroupMembers(groupId: string): Promise<GroupMember[]> {
    const data = await this.request(`/usergroups/${groupId}/members`);
    return GroupMembersResponseSchema.parse(data);
  }

  async resolvePermissions(
    userId: string,
    rbacConfig: RBACConfig,
  ): Promise<{
    groups: UserGroup[];
    allowedAgents: string[];
    dataSources: Record<string, DataSourcePermissions>;
  }> {
    const groups = await this.getUserGroups(userId);
    const groupNames = new Set(groups.map((g) => g.name));

    const allowedAgents = new Set<string>();
    const mergedDataSources: Record<string, DataSourcePermissions> = {};

    for (const [groupName, groupConfig] of Object.entries(rbacConfig.groups)) {
      if (!groupNames.has(groupName)) continue;

      for (const agent of groupConfig.agents) {
        allowedAgents.add(agent);
      }

      for (const [source, perms] of Object.entries(groupConfig.dataSources)) {
        if (!mergedDataSources[source]) {
          mergedDataSources[source] = { ...perms };
        }
      }
    }

    return {
      groups,
      allowedAgents: [...allowedAgents],
      dataSources: mergedDataSources,
    };
  }

  private async request(path: string): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);

        const response = await fetch(url, {
          headers: {
            'x-api-key': this.apiKey,
            Accept: 'application/json',
          },
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          const errorText = await response.text();
          throw new JumpCloudApiError(response.status, path, errorText);
        }

        return await response.json();
      } catch (error) {
        lastError = error as Error;

        if (error instanceof Error && error.name === 'AbortError') {
          throw new JumpCloudApiError(0, path, `Request timeout after ${this.timeout}ms`);
        }

        if (error instanceof JumpCloudApiError && (error.status === 401 || error.status === 403)) {
          throw error;
        }

        if (attempt < this.retries) {
          const delay = Math.pow(2, attempt) * 500;
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        throw error;
      }
    }

    throw lastError ?? new Error('Request failed');
  }
}
