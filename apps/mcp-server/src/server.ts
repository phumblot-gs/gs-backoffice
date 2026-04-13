import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PluginManager } from './plugins/manager.js';
import type { ToolContext } from './plugins/types.js';

export function createHenriMcpServer(
  pluginManager: PluginManager,
  userContext: ToolContext,
): McpServer {
  const server = new McpServer({
    name: 'henri',
    version: '0.2.0',
  });

  pluginManager.registerToolsOnServer(server, userContext);

  return server;
}
