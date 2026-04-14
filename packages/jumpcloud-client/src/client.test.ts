import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JumpCloudClient } from './client.js';
import { JumpCloudApiError } from './errors.js';

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

// Mock response for /usergroups (group name resolution)
const groupListResponse = [
  { id: 'grp-1', name: 'Finance' },
  { id: 'grp-2', name: 'Engineering' },
  { id: 'grp-3', name: 'Management Team' },
];

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
    it('returns groups with resolved names', async () => {
      // First call: /users/{id}/memberof
      mockFetch.mockResolvedValueOnce(
        jsonResponse([
          { id: 'grp-1', name: 'grp-1', type: 'user_group' },
          { id: 'grp-2', name: 'grp-2', type: 'user_group' },
        ]),
      );
      // Second call: /usergroups (name resolution)
      mockFetch.mockResolvedValueOnce(jsonResponse(groupListResponse));

      const groups = await client.getUserGroups('user-1');
      expect(groups).toHaveLength(2);
      expect(groups[0].name).toBe('Finance');
      expect(groups[1].name).toBe('Engineering');
    });

    it('sends x-api-key header', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse([]));
      mockFetch.mockResolvedValueOnce(jsonResponse(groupListResponse));
      await client.getUserGroups('user-1');

      const callHeaders = mockFetch.mock.calls[0][1].headers;
      expect(callHeaders['x-api-key']).toBe('test-jc-key');
    });

    it('throws JumpCloudApiError on 401', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ message: 'Unauthorized' }, 401));
      await expect(client.getUserGroups('user-1')).rejects.toThrow(JumpCloudApiError);
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

  describe('findUserByEmail', () => {
    it('finds user by exact email match', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          results: [
            {
              _id: 'user-123',
              email: 'pierre@grand-shooting.com',
              firstname: 'Pierre',
              lastname: 'Test',
              username: 'pierre',
            },
          ],
        }),
      );

      const user = await client.findUserByEmail('pierre@grand-shooting.com');
      expect(user).not.toBeNull();
      expect(user!.id).toBe('user-123');
      expect(user!.email).toBe('pierre@grand-shooting.com');
    });

    it('finds user by managedAppleId fallback', async () => {
      // First call: exact email filter returns nothing
      mockFetch.mockResolvedValueOnce(jsonResponse({ results: [] }));
      // Second call: list all users, find by managedAppleId
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          results: [
            {
              _id: 'user-456',
              email: 'phf@grand-shooting.com',
              managedAppleId: 'pierre@grand-shooting.com',
              firstname: 'Pierre',
              lastname: 'HF',
              username: 'phf',
            },
          ],
        }),
      );

      const user = await client.findUserByEmail('pierre@grand-shooting.com');
      expect(user).not.toBeNull();
      expect(user!.id).toBe('user-456');
      expect(user!.username).toBe('phf');
    });

    it('returns null when user not found', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ results: [] }));
      mockFetch.mockResolvedValueOnce(jsonResponse({ results: [] }));

      const user = await client.findUserByEmail('unknown@example.com');
      expect(user).toBeNull();
    });
  });
});
