import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JumpCloudClient } from './client.js';
import { JumpCloudApiError } from './errors.js';
import type { RBACConfig } from '@gs-backoffice/core';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
    headers: new Headers(),
  } as Response;
}

describe('JumpCloudClient', () => {
  let client: JumpCloudClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new JumpCloudClient({
      apiKey: 'test-jc-key',
      orgId: 'org-123',
      baseUrl: 'https://mock-jc.test/api/v2',
      retries: 0,
      timeout: 5000,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getUserGroups', () => {
    it('returns validated user groups', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse([
          { id: 'grp-1', name: 'Finance', type: 'user_group' },
          { id: 'grp-2', name: 'Engineering', type: 'user_group' },
        ]),
      );

      const groups = await client.getUserGroups('user-1');
      expect(groups).toHaveLength(2);
      expect(groups[0].name).toBe('Finance');
    });

    it('sends x-api-key header', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse([]));
      await client.getUserGroups('user-1');

      const callHeaders = mockFetch.mock.calls[0][1].headers;
      expect(callHeaders['x-api-key']).toBe('test-jc-key');
    });

    it('throws JumpCloudApiError on 401', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ message: 'Unauthorized' }, 401));

      await expect(client.getUserGroups('user-1')).rejects.toThrow(JumpCloudApiError);
    });

    it('validates response shape', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse([{ id: 'grp-1' }]), // Missing 'name' and 'type'
      );

      await expect(client.getUserGroups('user-1')).rejects.toThrow();
    });
  });

  describe('getGroupMembers', () => {
    it('returns validated group members', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse([
          { id: 'user-1', type: 'user' },
          { id: 'user-2', type: 'user' },
        ]),
      );

      const members = await client.getGroupMembers('grp-1');
      expect(members).toHaveLength(2);
      expect(members[0].id).toBe('user-1');
    });
  });

  describe('resolvePermissions', () => {
    const rbacConfig: RBACConfig = {
      groups: {
        Finance: {
          dataSources: {
            hyperline: { read: true, scopes: ['invoices', 'subscriptions'] },
            pennylane: { read: true, scopes: ['accounting'] },
          },
          agents: ['chief-of-staff', 'finance'],
        },
        Engineering: {
          dataSources: {
            linear: { read: true, scopes: ['bugs', 'features'] },
          },
          agents: ['chief-of-staff', 'data-officer'],
        },
      },
    };

    it('merges permissions from multiple groups', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse([
          { id: 'grp-1', name: 'Finance', type: 'user_group' },
          { id: 'grp-2', name: 'Engineering', type: 'user_group' },
        ]),
      );

      const perms = await client.resolvePermissions('user-1', rbacConfig);
      expect(perms.groups).toHaveLength(2);
      expect(perms.allowedAgents).toContain('chief-of-staff');
      expect(perms.allowedAgents).toContain('finance');
      expect(perms.allowedAgents).toContain('data-officer');
      expect(perms.dataSources.hyperline).toBeDefined();
      expect(perms.dataSources.linear).toBeDefined();
    });

    it('returns empty permissions for unmatched groups', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse([{ id: 'grp-99', name: 'Marketing', type: 'user_group' }]),
      );

      const perms = await client.resolvePermissions('user-1', rbacConfig);
      expect(perms.allowedAgents).toHaveLength(0);
      expect(Object.keys(perms.dataSources)).toHaveLength(0);
    });
  });
});
