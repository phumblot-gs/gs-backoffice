import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import pino from 'pino';
import type { EvtClient } from '@gs-backoffice/evt-client';
import type { EvtActor, EvtScope } from '@gs-backoffice/core';
import { createBackofficeEvent } from '@gs-backoffice/core';
import type { ServicePlugin, PluginTool, ToolContext, PluginInitConfig } from './types.js';

const logger = pino({ name: 'plugin-manager' });

export class PluginManager {
  private plugins: ServicePlugin[] = [];
  private evtClient: EvtClient | null;
  private environment: string;

  constructor(opts: { evtClient: EvtClient | null; environment: string }) {
    this.evtClient = opts.evtClient;
    this.environment =
      opts.environment === 'production'
        ? 'production'
        : opts.environment === 'staging'
          ? 'staging'
          : 'development';
  }

  async register(plugin: ServicePlugin, config: PluginInitConfig): Promise<void> {
    await plugin.initialize(config);
    this.plugins.push(plugin);
    logger.info(
      { plugin: plugin.name, tools: plugin.getTools().map((t) => t.name) },
      'Plugin registered',
    );
  }

  getAllTools(): PluginTool[] {
    return this.plugins.flatMap((p) => p.getTools());
  }

  getAuthorizedTools(permissions: string[]): PluginTool[] {
    const permSet = new Set(permissions);
    const hasWildcard = permSet.has('*');
    return this.getAllTools().filter((tool) => hasWildcard || permSet.has(tool.requiredPermission));
  }

  registerToolsOnServer(server: McpServer, context: ToolContext): void {
    const tools = this.getAuthorizedTools(context.permissions);

    for (const tool of tools) {
      server.tool(tool.name, tool.description, tool.schema.shape, async (input) => {
        const parsed = tool.schema.parse(input);
        const result = await tool.execute(parsed as Record<string, unknown>, context);

        if (tool.evtEventType && this.evtClient) {
          try {
            const actor: EvtActor = {
              userId: context.userId,
              accountId: 'grafmaker',
              role: context.groups[0],
            };
            const scope: EvtScope = {
              accountId: 'grafmaker',
              resourceType: tool.name,
              resourceId: context.userId,
            };
            const event = createBackofficeEvent(
              tool.evtEventType,
              actor,
              scope,
              {
                tool: tool.name,
                userEmail: context.userEmail,
                input: parsed,
                isError: result.isError ?? false,
              },
              this.environment as 'development' | 'staging' | 'production',
            );
            await this.evtClient.publish(event);
          } catch (err) {
            logger.warn({ error: err, tool: tool.name }, 'Failed to publish EVT audit event');
          }
        }

        return result;
      });
    }

    logger.info(
      {
        userId: context.userId,
        registeredTools: tools.map((t) => t.name),
        totalAvailable: this.getAllTools().length,
      },
      'Tools registered for session',
    );
  }
}
