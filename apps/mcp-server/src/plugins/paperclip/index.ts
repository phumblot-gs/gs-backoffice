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

/**
 * Employee-triggerable official processes carry a stable code in parentheses at
 * the END of their routine title, e.g. "Register a contract (register-contract)".
 * That code is the handle referenced in config/rbac.json `workflows`. Routines
 * WITHOUT such a code are internal automations (e.g. PR validation) and are
 * NEVER exposed to employees. Returns the code, or null.
 */
export function extractWorkflowCode(title: string | undefined | null): string | null {
  if (!title) return null;
  const m = title.match(/\(([A-Za-z0-9][A-Za-z0-9_-]*)\)\s*$/);
  return m ? m[1] : null;
}

export class PaperclipPlugin implements ServicePlugin {
  readonly name = 'paperclip';
  readonly description = 'Manage back office workflows and tickets via Paperclip';
  readonly attributionLevel = 2 as const;

  private client!: PaperclipClient;
  private logger!: Logger;
  private companyId = '';

  async initialize(config: PluginInitConfig): Promise<void> {
    this.logger = config.logger;
    this.companyId = config.credentials.PAPERCLIP_COMPANY_ID ?? '';
    this.client = new PaperclipClient({
      apiUrl: config.credentials.PAPERCLIP_API_URL ?? 'http://localhost:3100',
      apiKey: config.credentials.PAPERCLIP_API_KEY,
    });
  }

  getTools(): PluginTool[] {
    return [
      this.listWorkflowsTool(),
      this.startWorkflowTool(),
      this.ticketStatusTool(),
      this.ticketUpdateTool(),
      this.digestTool(),
    ];
  }

  private listWorkflowsTool(): PluginTool {
    return {
      name: 'henri_list_workflows',
      description:
        'List the official back office processes (workflows) you are allowed to trigger. ' +
        'Use this before henri_start_workflow to discover available processes.',
      schema: z.object({}),
      requiredPermission: 'paperclip.read',
      evtEventType: null,
      execute: async (_input, context) => this.executeListWorkflows(context),
    };
  }

  private startWorkflowTool(): PluginTool {
    return {
      name: 'henri_start_workflow',
      description:
        'Trigger an official back office process by its code. ' +
        'Call henri_list_workflows first to get the available process codes. ' +
        'Only processes you are explicitly authorized for can be triggered.',
      schema: z.object({
        workflow: z
          .string()
          .describe('The process CODE from henri_list_workflows (e.g., "register-contract")'),
        parameters: z
          .record(z.string())
          .optional()
          .describe('Key-value parameters passed to the process'),
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

  /** Fetch the company's routines, tolerating array or { routines | data } shapes. */
  private async fetchRoutines(): Promise<Array<Record<string, unknown>>> {
    const raw = (await this.client.listRoutines(this.companyId)) as unknown;
    return (
      Array.isArray(raw)
        ? raw
        : ((raw as { routines?: unknown[] }).routines ?? (raw as { data?: unknown[] }).data ?? [])
    ) as Array<Record<string, unknown>>;
  }

  /** A process code is allowed if the user has `*` or the code is in their allowlist. */
  private codeAllowed(code: string | null, allowed: string[]): boolean {
    if (!code) return false;
    if (allowed.includes('*')) return true;
    return allowed.map((a) => a.toLowerCase()).includes(code.toLowerCase());
  }

  private async executeListWorkflows(context: ToolContext): Promise<CallToolResult> {
    try {
      const allowed = context.workflows ?? [];
      if (allowed.length === 0) {
        return {
          content: [
            { type: 'text', text: 'You are not authorized to trigger any official process.' },
          ],
        };
      }
      const visible = (await this.fetchRoutines())
        .map((r) => ({
          r,
          code: extractWorkflowCode(typeof r.title === 'string' ? r.title : null),
        }))
        .filter(({ code }) => this.codeAllowed(code, allowed));
      if (visible.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: 'No official processes are available to you yet. Publish them as Paperclip routines whose title ends with a code, e.g. "Register a contract (register-contract)", then allow the code in config/rbac.json.',
            },
          ],
        };
      }
      const lines = visible.map(({ r, code }) => {
        const title = String(r.title ?? r.id);
        const firstLine =
          typeof r.description === 'string' && r.description
            ? ` — ${r.description.split('\n')[0].slice(0, 120)}`
            : '';
        const paused = r.status === 'paused' ? ' _(paused)_' : '';
        return `- \`${code}\` — **${title}**${paused}${firstLine}`;
      });
      return {
        content: [
          {
            type: 'text',
            text: `## Official processes you can trigger\n\nUse the code with henri_start_workflow.\n\n${lines.join('\n')}`,
          },
        ],
      };
    } catch (err) {
      this.logger.error({ error: err }, 'Failed to list workflows');
      return {
        content: [
          {
            type: 'text',
            text: `Error listing workflows: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }

  private async executeStartWorkflow(
    input: { workflow: string; parameters?: Record<string, string>; notes?: string },
    context: ToolContext,
  ): Promise<CallToolResult> {
    const requested = input.workflow.trim();
    const allowed = context.workflows ?? [];
    try {
      if (allowed.length === 0) {
        return {
          content: [
            { type: 'text', text: 'You are not authorized to trigger any official process.' },
          ],
        };
      }

      // Resolve the routine by its title code (the official-process handle).
      const match = (await this.fetchRoutines()).find(
        (r) =>
          extractWorkflowCode(typeof r.title === 'string' ? r.title : null)?.toLowerCase() ===
          requested.toLowerCase(),
      );
      const code = match ? extractWorkflowCode(String(match.title)) : null;

      // Fail-closed: unknown process OR not in the user's allowlist → identical denial
      // (don't reveal the existence of processes the user can't trigger).
      if (!match || !this.codeAllowed(code, allowed)) {
        return {
          content: [
            {
              type: 'text',
              text: `Unknown or unauthorized process "${requested}". Call henri_list_workflows to see what you can trigger.`,
            },
          ],
        };
      }

      const run = await this.client.runRoutine(String(match.id), {
        variables: input.parameters,
        payload: { requestedBy: context.userEmail, notes: input.notes, processCode: code },
      });
      const runId = run.id ?? run.runId ?? '(queued)';
      return {
        content: [
          {
            type: 'text',
            text: `Official process **${code}** (${String(match.title)}) triggered — run **${String(runId)}**. The assigned agent will handle it.`,
          },
        ],
      };
    } catch (err) {
      this.logger.error({ error: err, workflow: requested }, 'Failed to start workflow');
      return {
        content: [
          {
            type: 'text',
            text: `Error starting process: ${err instanceof Error ? err.message : String(err)}`,
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
