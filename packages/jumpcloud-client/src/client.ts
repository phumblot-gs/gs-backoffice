import type { JumpCloudConfig, UserGroup, GroupMember } from './types.js';
import { UserGroupsResponseSchema, GroupMembersResponseSchema } from './types.js';
import { JumpCloudApiError } from './errors.js';

const DEFAULT_BASE_URL = 'https://console.jumpcloud.com/api/v2';
const V1_BASE_URL = 'https://console.jumpcloud.com/api';
const DEFAULT_TIMEOUT = 10000;
const DEFAULT_RETRIES = 2;

interface JumpCloudUser {
  id: string;
  email: string;
  firstname: string;
  lastname: string;
  username: string;
}

export class JumpCloudClient {
  private readonly baseUrl: string;
  private readonly v1BaseUrl: string;
  private readonly apiKey: string;
  private readonly timeout: number;
  private readonly retries: number;

  // Cache group names (they rarely change)
  private groupNameCache = new Map<string, string>();
  private groupNameCacheTimestamp = 0;
  private static GROUP_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

  constructor(config: JumpCloudConfig) {
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.v1BaseUrl = V1_BASE_URL;
    this.apiKey = config.apiKey;
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT;
    this.retries = config.retries ?? DEFAULT_RETRIES;
  }

  /**
   * Find a JumpCloud user by email.
   * Searches both email and managedAppleId fields (Google Workspace sync).
   */
  async findUserByEmail(email: string): Promise<JumpCloudUser | null> {
    const data = (await this.requestV1(
      `/systemusers?filter=email:eq:${encodeURIComponent(email)}&limit=1`,
    )) as { results: Array<Record<string, unknown>> };

    if (data.results.length > 0) {
      return this.parseUser(data.results[0]);
    }

    // Try searching all users and matching by managedAppleId or alternate email
    const allUsers = (await this.requestV1(`/systemusers?limit=200`)) as {
      results: Array<Record<string, unknown>>;
    };

    for (const user of allUsers.results) {
      if (
        user.managedAppleId === email ||
        user.email === email ||
        (user.alternateEmail as string | null) === email
      ) {
        return this.parseUser(user);
      }
    }

    return null;
  }

  /**
   * Get groups for a user by userId (v2 API).
   * Returns groups with resolved names.
   */
  async getUserGroups(userId: string): Promise<UserGroup[]> {
    const data = await this.request(`/users/${userId}/memberof`);
    const rawGroups = UserGroupsResponseSchema.parse(data);

    // Resolve group names
    await this.ensureGroupNameCache();
    return rawGroups.map((g) => ({
      ...g,
      name: this.groupNameCache.get(g.id) ?? g.name,
    }));
  }

  /**
   * Get groups for a user by email.
   * Combines findUserByEmail + getUserGroups.
   */
  async getUserGroupsByEmail(
    email: string,
  ): Promise<{ user: JumpCloudUser; groups: UserGroup[] } | null> {
    const user = await this.findUserByEmail(email);
    if (!user) return null;

    const groups = await this.getUserGroups(user.id);
    return { user, groups };
  }

  async getGroupMembers(groupId: string): Promise<GroupMember[]> {
    const data = await this.request(`/usergroups/${groupId}/members`);
    return GroupMembersResponseSchema.parse(data);
  }

  /**
   * Load all group names into cache.
   */
  private async ensureGroupNameCache(): Promise<void> {
    if (
      this.groupNameCache.size > 0 &&
      Date.now() - this.groupNameCacheTimestamp < JumpCloudClient.GROUP_CACHE_TTL
    ) {
      return;
    }

    const data = (await this.request('/usergroups?limit=200')) as Array<{
      id: string;
      name: string;
    }>;
    this.groupNameCache.clear();
    for (const group of data) {
      this.groupNameCache.set(group.id, group.name);
    }
    this.groupNameCacheTimestamp = Date.now();
  }

  private parseUser(raw: Record<string, unknown>): JumpCloudUser {
    return {
      id: (raw._id as string) ?? (raw.id as string) ?? '',
      email: (raw.email as string) ?? '',
      firstname: (raw.firstname as string) ?? '',
      lastname: (raw.lastname as string) ?? '',
      username: (raw.username as string) ?? '',
    };
  }

  private async request(path: string): Promise<unknown> {
    return this.doRequest(`${this.baseUrl}${path}`);
  }

  private async requestV1(path: string): Promise<unknown> {
    return this.doRequest(`${this.v1BaseUrl}${path}`);
  }

  private async doRequest(url: string): Promise<unknown> {
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
          throw new JumpCloudApiError(response.status, url, errorText);
        }

        return await response.json();
      } catch (error) {
        lastError = error as Error;

        if (error instanceof Error && error.name === 'AbortError') {
          throw new JumpCloudApiError(0, url, `Request timeout after ${this.timeout}ms`);
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
