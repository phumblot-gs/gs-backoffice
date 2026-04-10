import type { JumpCloudConfig, UserGroup } from './types.js';

const DEFAULT_BASE_URL = 'https://console.jumpcloud.com/api/v2';

export class JumpCloudClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(config: JumpCloudConfig) {
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.apiKey = config.apiKey;
  }

  async getUserGroups(userId: string): Promise<UserGroup[]> {
    const res = await fetch(`${this.baseUrl}/users/${userId}/memberof`, {
      headers: {
        'x-api-key': this.apiKey,
        Accept: 'application/json',
      },
    });
    if (!res.ok) {
      throw new Error(`JumpCloud getUserGroups failed: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as UserGroup[];
  }

  async getGroupMembers(groupId: string): Promise<{ id: string; type: string }[]> {
    const res = await fetch(`${this.baseUrl}/usergroups/${groupId}/members`, {
      headers: {
        'x-api-key': this.apiKey,
        Accept: 'application/json',
      },
    });
    if (!res.ok) {
      throw new Error(`JumpCloud getGroupMembers failed: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as { id: string; type: string }[];
  }
}
