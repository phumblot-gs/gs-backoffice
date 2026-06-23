import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ElicitResultSchema } from '@modelcontextprotocol/sdk/types.js';
import pino from 'pino';
import type { EvtClient } from '@gs-backoffice/evt-client';
import type { EvtActor, EvtScope } from '@gs-backoffice/core';
import { createBackofficeEvent, AUDIT_TOOL_INVOKED } from '@gs-backoffice/core';
import type { ServicePlugin, PluginTool, ToolContext, PluginInitConfig, Elicit } from './types.js';

const logger = pino({ name: 'plugin-manager' });

export class PluginManager {
  private plugins: ServicePlugin[] = [];
  private evtClient: EvtClient | null;
  private environment: string;
  // EVT account id (UUID/identifier expected by EVT). Configured via EVT_ACCOUNT_ID;
  // must NOT be a free-form slug (EVT stores it in a typed column).
  private evtAccountId: string;

  constructor(opts: { evtClient: EvtClient | null; environment: string; evtAccountId?: string }) {
    this.evtClient = opts.evtClient;
    this.evtAccountId = opts.evtAccountId ?? '';
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
      server.tool(tool.name, tool.description, tool.schema.shape, async (input, sdkExtra) => {
        const parsed = tool.schema.parse(input);
        // Elicitation handle: ask the client to render an interactive form. Returns null
        // if the client didn't advertise the `elicitation` capability (or the request
        // fails) — the tool then falls back to a text flow. Never throws.
        const elicit: Elicit = async ({ message, schema }) => {
          try {
            const request = {
              method: 'elicitation/create',
              params: { message, requestedSchema: schema },
            } as Parameters<typeof sdkExtra.sendRequest>[0];
            const res = await sdkExtra.sendRequest(request, ElicitResultSchema);
            return { action: res.action, content: res.content };
          } catch (err) {
            logger.info(
              { tool: tool.name, error: err instanceof Error ? err.message : String(err) },
              'Elicitation unavailable — falling back to text flow',
            );
            return null;
          }
        };
        const result = await tool.execute(parsed as Record<string, unknown>, context, { elicit });

        if (tool.auditCategory) {
          const actor: EvtActor = {
            userId: context.userId,
            accountId: this.evtAccountId,
            role: context.groups[0],
          };
          const scope: EvtScope = {
            accountId: this.evtAccountId,
            resourceType: tool.name,
            resourceId: context.userId,
          };
          // Always the dedicated audit type — never a business event type — so audit
          // and business events are unambiguous on the bus. The action is the category.
          const event = createBackofficeEvent(
            AUDIT_TOOL_INVOKED,
            actor,
            scope,
            {
              tool: tool.name,
              category: tool.auditCategory,
              userEmail: context.userEmail,
              input: parsed,
              isError: result.isError ?? false,
            },
            this.environment as 'development' | 'staging' | 'production',
          );
          // Durable audit trail (SOC 2 CC7): always record to the structured logger
          // (CloudWatch), independent of EVT availability — Comp AI can pull evidence here.
          logger.info({ audit: event }, 'audit_event');
          // Best-effort forward to the EVT bus; a failure must not break the tool or lose the audit.
          if (this.evtClient) {
            try {
              await this.evtClient.publish(event);
            } catch (err) {
              logger.warn(
                { error: err, tool: tool.name },
                'EVT publish failed (audit still recorded in CloudWatch)',
              );
            }
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
