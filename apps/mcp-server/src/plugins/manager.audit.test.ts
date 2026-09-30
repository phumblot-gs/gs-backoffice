import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import pino from 'pino';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ServicePlugin } from './types.js';
const publish = vi.hoisted(() => vi.fn());
vi.mock('@gs-backoffice/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gs-backoffice/audit')>()),
  createAuditPublisher: () => publish,
}));
import { PluginManager } from './manager.js';
beforeEach(() => {
  vi.stubEnv('AUDIT_QUEUE_REQUIRED', 'true');
  publish.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());
async function tool(
  name: string,
  execute = vi.fn().mockResolvedValue({ content: [] }),
  permissions = ['*'],
) {
  const manager = new PluginManager({
    evtClient: null,
    environment: 'staging',
    evtAccountId: 'account',
  });
  const plugin: ServicePlugin = {
    name: 'test',
    description: 'test',
    attributionLevel: 1,
    initialize: async () => {},
    getTools: () => [
      {
        name,
        description: 'test',
        schema: z.object({ token: z.string() }),
        requiredPermission: 'write',
        auditCategory: null,
        execute,
      },
    ],
  };
  await manager.register(plugin, {
    credentials: {},
    evtClient: null,
    logger: pino({ level: 'silent' }),
  });
  let handler: ((input: unknown, extra: unknown) => Promise<CallToolResult>) | undefined;
  manager.registerToolsOnServer(
    {
      tool: (_name: string, _description: string, _schema: unknown, cb: typeof handler) => {
        handler = cb;
      },
    } as unknown as McpServer,
    {
      userId: 'human',
      userEmail: 'user@example.com',
      groups: ['Comex'],
      permissions,
      scopes: {},
      workflows: [],
      agents: [],
    },
  );
  return { handler, execute };
}
describe('employee audit integration', () => {
  it('defaults unknown tools to the sensitive gate even with no legacy audit category', async () => {
    publish.mockRejectedValue(new Error('offline'));
    const t = await tool('new_mutation');
    expect(await t.handler!({ token: 'never-log-me' }, {})).toMatchObject({ isError: true });
    expect(t.execute).not.toHaveBeenCalled();
  });
  it('records the human and input names without storing raw values', async () => {
    const t = await tool('new_mutation');
    await t.handler!({ token: 'never-log-me' }, {});
    expect(t.execute).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[0][0].actor.userId).toBe('human');
    expect(JSON.stringify(publish.mock.calls)).not.toContain('never-log-me');
    expect(publish.mock.calls[0][0].payload.inputKeys).toEqual(['token']);
  });
  it('permits an explicitly read-only tool while deposit is unavailable', async () => {
    publish.mockRejectedValue(new Error('offline'));
    const t = await tool('henri_ticket_status');
    expect(await t.handler!({ token: 'value' }, {})).toEqual({ content: [] });
    expect(t.execute).toHaveBeenCalledTimes(1);
  });
  it('does not bypass existing permissions', async () => {
    const t = await tool('new_mutation', undefined, []);
    expect(t.handler).toBeUndefined();
    expect(publish).not.toHaveBeenCalled();
  });
});
