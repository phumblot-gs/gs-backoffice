import { z } from 'zod';
import type { Logger } from 'pino';
import type {
  ServicePlugin,
  PluginTool,
  PluginInitConfig,
  ToolContext,
  CallToolResult,
} from '../types.js';
import { PaperclipClient } from '../../paperclip-client.js';

export class PaperclipPlugin implements ServicePlugin {
  readonly name = 'paperclip';
  readonly description = 'Manage back office workflows and tickets via Paperclip';
  readonly attributionLevel = 2 as const;

  private client!: PaperclipClient;
  private logger!: Logger;
  private companyId = '';
  private chiefOfStaffAgentId = '';

  async initialize(config: PluginInitConfig): Promise<void> {
    this.logger = config.logger;
    this.companyId = config.credentials.PAPERCLIP_COMPANY_ID ?? '';
    this.chiefOfStaffAgentId = config.credentials.CHIEF_OF_STAFF_AGENT_ID ?? '';
    this.client = new PaperclipClient({
      apiUrl: config.credentials.PAPERCLIP_API_URL ?? 'http://localhost:3100',
      apiKey: config.credentials.PAPERCLIP_API_KEY,
    });
  }

  getTools(): PluginTool[] {
    return [
      this.startWorkflowTool(),
      this.ticketStatusTool(),
      this.ticketUpdateTool(),
      this.digestTool(),
    ];
  }

  private startWorkflowTool(): PluginTool {
    return {
      name: 'henri_start_workflow',
      description:
        'Start a back office workflow (e.g., "invoice client X", "register contract"). ' +
        'Creates a ticket that will be handled by the appropriate agent.',
      schema: z.object({
        workflow: z
          .string()
          .describe('Name of the workflow to start (e.g., "invoice client Acme Corp")'),
        parameters: z
          .record(z.string())
          .optional()
          .describe('Key-value parameters for the workflow'),
        notes: z.string().optional().describe('Additional notes'),
      }),
      requiredPermission: 'paperclip.create_ticket',
      evtEventType: 'backoffice.workflow.started',
      execute: async (input, context) =>
        this.executeStartWorkflow(
          input as { workflow: string; parameters?: Record<string, string>; notes?: string },
          context,
        ),
    };
  }

  private ticketStatusTool(): PluginTool {
    return {
      name: 'henri_ticket_status',
      description: 'Check the status of an existing back office ticket.',
      schema: z.object({
        ticketId: z.string().describe('The ticket ID (e.g., "GRA-1")'),
      }),
      requiredPermission: 'paperclip.read',
      evtEventType: null,
      execute: async (input) => this.executeTicketStatus(input as { ticketId: string }),
    };
  }

  private ticketUpdateTool(): PluginTool {
    return {
      name: 'henri_ticket_update',
      description: 'Add a comment or information to an existing ticket.',
      schema: z.object({
        ticketId: z.string().describe('The ticket ID to update'),
        message: z.string().describe('Message to add to the ticket'),
      }),
      requiredPermission: 'paperclip.update_ticket',
      evtEventType: 'backoffice.ticket.updated',
      execute: async (input, context) =>
        this.executeTicketUpdate(input as { ticketId: string; message: string }, context),
    };
  }

  private digestTool(): PluginTool {
    return {
      name: 'henri_digest',
      description: 'Get the latest internal digest (weekly summary across departments).',
      schema: z.object({
        period: z
          .enum(['daily', 'weekly', 'monthly'])
          .optional()
          .describe('Digest period (defaults to weekly)'),
      }),
      requiredPermission: 'paperclip.read',
      evtEventType: null,
      execute: async (input) => this.executeDigest(input as { period?: string }),
    };
  }

  private async executeStartWorkflow(
    input: { workflow: string; parameters?: Record<string, string>; notes?: string },
    context: ToolContext,
  ): Promise<CallToolResult> {
    try {
      const paramsList = input.parameters
        ? Object.entries(input.parameters)
            .map(([k, v]) => `- **${k}:** ${v}`)
            .join('\n')
        : '';

      const issue = await this.client.createIssue({
        companyId: this.companyId,
        title: `Workflow: ${input.workflow.slice(0, 180)}`,
        description: [
          `**Requested by:** ${context.userEmail}`,
          `**Workflow:** ${input.workflow}`,
          paramsList ? `\n**Parameters:**\n${paramsList}` : '',
          input.notes ? `\n**Notes:** ${input.notes}` : '',
        ].join('\n'),
        assigneeAgentId: this.chiefOfStaffAgentId,
        priority: 'medium',
        metadata: {
          workflowName: input.workflow,
          requestedBy: context.userEmail,
          parameters: input.parameters,
        },
      });

      const ticketId = issue.identifier ?? issue.shortId ?? issue.id;
      return {
        content: [
          {
            type: 'text',
            text: `Workflow "${input.workflow}" started — ticket **${ticketId}**. The Chief of Staff will delegate to the appropriate agent. You can check progress with henri_ticket_status.`,
          },
        ],
      };
    } catch (err) {
      this.logger.error({ error: err }, 'Failed to create workflow ticket');
      return {
        content: [
          {
            type: 'text',
            text: `Error starting workflow: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }

  private async executeTicketStatus(input: { ticketId: string }): Promise<CallToolResult> {
    try {
      const issue = await this.client.getIssue(input.ticketId);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                id: issue.identifier ?? issue.shortId ?? issue.id,
                title: issue.title,
                status: issue.status,
                priority: issue.priority,
                assignee: issue.assigneeAgentId,
                createdAt: issue.createdAt,
                updatedAt: issue.updatedAt,
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: `Error fetching ticket: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }

  private async executeTicketUpdate(
    input: { ticketId: string; message: string },
    context: ToolContext,
  ): Promise<CallToolResult> {
    try {
      const comment = await this.client.addComment(
        input.ticketId,
        `**${context.userEmail}:** ${input.message}`,
      );
      return {
        content: [
          {
            type: 'text',
            text: `Comment added to ticket ${input.ticketId} (comment ${comment.id}).`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: `Error updating ticket: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }

  private async executeDigest(input: { period?: string }): Promise<CallToolResult> {
    const period = input.period ?? 'weekly';
    return {
      content: [
        {
          type: 'text',
          text: `[${period} digest] No digest available yet. The Chief of Staff produces digests on its Friday 9:00 heartbeat. This feature will be fully operational once the agent heartbeats are active.`,
        },
      ],
    };
  }
}
