import { z } from 'zod';
import type { Logger } from 'pino';
import { canApprove, createBackofficeEvent } from '@gs-backoffice/core';
import type { EvtClient } from '@gs-backoffice/evt-client';
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

/**
 * Approval gate (Capability 2b). A process is SENSITIVE when its routine title
 * starts with `!` (the Methods Officer marks it, e.g. "!Pay supplier (pay-supplier)").
 * A sensitive process is NOT run on request: an approval-request ticket is created
 * and a separate authorized approver must approve it before the routine runs.
 */
export function isSensitiveProcess(title: string | undefined | null): boolean {
  return !!title && title.trimStart().startsWith('!');
}

// Machine-readable marker embedded in the approval ticket description (the API has
// no metadata field). The fenced JSON block is the source of truth re-read on approval.
const APPROVAL_MARKER = 'gs-approval-request';

interface ApprovalPayload {
  kind: typeof APPROVAL_MARKER;
  routineId: string;
  processCode: string;
  scope: string | null;
  requestedBy: string;
  parameters?: Record<string, string>;
  notes?: string;
}

export function buildApprovalDescription(p: ApprovalPayload): string {
  const human = [
    `**Sensitive process awaiting approval.**`,
    ``,
    `- Process: \`${p.processCode}\``,
    `- Requested by: ${p.requestedBy}`,
    `- Approval scope: ${p.scope ?? 'leadership (no scope declared)'}`,
    p.parameters && Object.keys(p.parameters).length
      ? `- Parameters: ${Object.entries(p.parameters)
          .map(([k, v]) => `${k}=${v}`)
          .join(', ')}`
      : null,
    p.notes ? `- Notes: ${p.notes}` : null,
    ``,
    `An authorized approver (≠ requester) must run \`henri_approve\` on this ticket.`,
    ``,
    '```json',
    JSON.stringify(p),
    '```',
  ]
    .filter((l) => l !== null)
    .join('\n');
  return human;
}

export function parseApprovalDescription(
  description: string | undefined | null,
): ApprovalPayload | null {
  if (!description) return null;
  const m = description.match(/```json\s*(\{[\s\S]*?\})\s*```/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[1]) as ApprovalPayload;
    return parsed.kind === APPROVAL_MARKER && parsed.routineId && parsed.processCode
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export class PaperclipPlugin implements ServicePlugin {
  readonly name = 'paperclip';
  readonly description = 'Manage back office workflows and tickets via Paperclip';
  readonly attributionLevel = 2 as const;

  private client!: PaperclipClient;
  private logger!: Logger;
  private companyId = '';
  private evtClient: EvtClient | null = null;
  private evtAccountId = '';
  private environment: 'development' | 'staging' | 'production' = 'development';

  async initialize(config: PluginInitConfig): Promise<void> {
    this.logger = config.logger;
    this.companyId = config.credentials.PAPERCLIP_COMPANY_ID ?? '';
    this.evtClient = config.evtClient;
    this.evtAccountId = process.env.EVT_ACCOUNT_ID ?? '';
    const env = process.env.NODE_ENV;
    this.environment =
      env === 'production' ? 'production' : env === 'staging' ? 'staging' : 'development';
    this.client = new PaperclipClient({
      apiUrl: config.credentials.PAPERCLIP_API_URL ?? 'http://localhost:3100',
      apiKey: config.credentials.PAPERCLIP_API_KEY,
    });
  }

  getTools(): PluginTool[] {
    return [
      this.listWorkflowsTool(),
      this.startWorkflowTool(),
      this.listApprovalsTool(),
      this.approveTool(),
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

  private listApprovalsTool(): PluginTool {
    return {
      name: 'henri_list_approvals',
      description:
        'List sensitive-process approval requests awaiting YOUR decision. ' +
        'Shows only requests you are authorized to approve (matching scope, and not your own request).',
      schema: z.object({}),
      requiredPermission: 'paperclip.approve',
      evtEventType: null,
      execute: async (_input, context) => this.executeListApprovals(context),
    };
  }

  private approveTool(): PluginTool {
    return {
      name: 'henri_approve',
      description:
        'Approve or reject a sensitive-process approval request (see henri_list_approvals). ' +
        'On approval the process runs; you cannot approve your own request.',
      schema: z.object({
        ticketId: z.string().describe('The approval ticket ID (e.g., "GRA-7")'),
        decision: z.enum(['approve', 'reject']).describe('Your decision'),
        note: z.string().optional().describe('Optional decision note (recorded on the ticket)'),
      }),
      requiredPermission: 'paperclip.approve',
      evtEventType: 'backoffice.approval.decided',
      execute: async (input, context) =>
        this.executeApprove(
          input as { ticketId: string; decision: 'approve' | 'reject'; note?: string },
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

  /**
   * Best-effort resolution of the GRA-x identifier of the issue Paperclip links to a
   * freshly triggered run, so the employee gets a ticket id usable with henri_ticket_status.
   * The link may not exist the instant the run is created, so poll briefly. Never throws —
   * returns null and the caller falls back to surfacing the run id.
   */
  private async resolveLinkedTicket(routineId: string, runId: string): Promise<string | null> {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const runs = await this.client.listRoutineRuns(routineId);
        const run = runs.find((r) => String(r.id ?? r.runId ?? '') === runId);
        const linkedId = run && (run.linkedIssueId ?? run.linked_issue_id ?? run.issueId);
        if (linkedId) {
          try {
            const issue = await this.client.getIssue(String(linkedId));
            const id = issue.identifier ?? issue.shortId ?? issue.id;
            return id ? String(id) : null;
          } catch {
            return null;
          }
        }
      } catch {
        // Endpoint may be unavailable or the run not yet listed — fall through and retry.
      }
      await new Promise((r) => setTimeout(r, 750));
    }
    return null;
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

      // Approval gate (2b): a sensitive process (routine title starts with `!`) is
      // NOT run on request — create an approval ticket and wait for an authorized
      // approver (≠ requester) to run henri_approve.
      if (isSensitiveProcess(typeof match.title === 'string' ? match.title : null)) {
        return this.createApprovalRequest(match, code!, input, context);
      }

      const run = await this.client.runRoutine(String(match.id), {
        variables: input.parameters,
        payload: { requestedBy: context.userEmail, notes: input.notes, processCode: code },
      });
      const runId = String(run.id ?? run.runId ?? '');
      // Surface the linked ticket id (GRA-x) so the employee can track it with
      // henri_ticket_status; fall back to the run id if it hasn't linked yet.
      const ticket = runId ? await this.resolveLinkedTicket(String(match.id), runId) : null;
      const ref = ticket
        ? `ticket **${ticket}** — track it with henri_ticket_status`
        : `run **${runId || '(queued)'}** — the ticket will appear shortly in Paperclip`;
      return {
        content: [
          {
            type: 'text',
            text: `Official process **${code}** (${String(match.title)}) triggered — ${ref}. The assigned agent will handle it.`,
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

  /** Resolve a process's approval scope from the company catalog (null = leadership-only). */
  private processScope(code: string, context: ToolContext): string | null {
    return context.processes?.[code]?.scope ?? null;
  }

  /** A claude.ai deep-link that opens a prefilled prompt for the approver to decide. */
  private approvalDeepLink(ticketId: string, code: string): string {
    const q = `Review back office approval request ${ticketId} for the sensitive process "${code}", then approve or reject it with henri_approve.`;
    return `https://claude.ai/new?q=${encodeURIComponent(q)}`;
  }

  /** Best-effort EVT publish for the approval lifecycle (audit + Google Chat routing). Never throws. */
  private async publishApproval(
    eventType: string,
    payload: Record<string, unknown>,
    context: ToolContext,
  ): Promise<void> {
    if (!this.evtClient) return;
    try {
      const event = createBackofficeEvent(
        eventType,
        { userId: context.userId, accountId: this.evtAccountId, role: context.groups[0] },
        {
          accountId: this.evtAccountId,
          resourceType: 'approval',
          resourceId: String(payload.ticketId ?? ''),
        },
        payload,
        this.environment,
      );
      await this.evtClient.publish(event);
    } catch (err) {
      this.logger.warn({ error: err, eventType }, 'EVT approval publish failed (non-fatal)');
    }
  }

  /** Create the approval-request ticket for a sensitive process (does NOT run it). */
  private async createApprovalRequest(
    match: Record<string, unknown>,
    code: string,
    input: { parameters?: Record<string, string>; notes?: string },
    context: ToolContext,
  ): Promise<CallToolResult> {
    const scope = this.processScope(code, context);
    const payload: ApprovalPayload = {
      kind: APPROVAL_MARKER,
      routineId: String(match.id),
      processCode: code,
      scope,
      requestedBy: context.userEmail,
      parameters: input.parameters,
      notes: input.notes,
    };
    const issue = await this.client.createIssue({
      companyId: this.companyId,
      title: `Approval needed: ${code} (requested by ${context.userEmail})`,
      status: 'blocked',
      priority: 'high',
      description: buildApprovalDescription(payload),
    });
    const ticketId = String(issue.identifier ?? issue.shortId ?? issue.id ?? '');
    await this.publishApproval(
      'backoffice.approval.requested',
      {
        ticketId,
        processCode: code,
        scope,
        requestedBy: context.userEmail,
        approveUrl: this.approvalDeepLink(ticketId, code),
      },
      context,
    );
    const who = scope ? `a **${scope}** approver` : 'a member of leadership';
    return {
      content: [
        {
          type: 'text',
          text: `🔒 **${code}** is a sensitive process — it requires approval before running.\n\nApproval request created: ticket **${ticketId}**. ${who} (other than you) must approve it via \`henri_approve\`, then it runs automatically. Track it with \`henri_ticket_status ${ticketId}\`.`,
        },
      ],
    };
  }

  private async executeApprove(
    input: { ticketId: string; decision: 'approve' | 'reject'; note?: string },
    context: ToolContext,
  ): Promise<CallToolResult> {
    try {
      const issue = await this.client.getIssue(input.ticketId);
      const payload = parseApprovalDescription(
        typeof issue.description === 'string' ? issue.description : null,
      );
      if (!payload) {
        return {
          content: [
            { type: 'text', text: `Ticket ${input.ticketId} is not a pending approval request.` },
          ],
          isError: true,
        };
      }
      // Idempotency: only a still-blocked request can be decided.
      if (issue.status && issue.status !== 'blocked') {
        return {
          content: [
            {
              type: 'text',
              text: `Approval ${input.ticketId} is already resolved (status: ${String(issue.status)}).`,
            },
          ],
        };
      }
      // Separation of duties: the requester cannot approve their own request.
      if (payload.requestedBy.toLowerCase() === context.userEmail.toLowerCase()) {
        return {
          content: [
            {
              type: 'text',
              text: `You cannot approve your own request (${input.ticketId}). Another authorized approver must decide.`,
            },
          ],
          isError: true,
        };
      }
      // Authorization: must hold paperclip.approve covering the process scope.
      if (!canApprove(context, payload.scope)) {
        return {
          content: [
            {
              type: 'text',
              text: `You are not authorized to approve process "${payload.processCode}" (scope: ${payload.scope ?? 'leadership'}).`,
            },
          ],
          isError: true,
        };
      }

      if (input.decision === 'reject') {
        await this.client.updateIssue(input.ticketId, {
          status: 'cancelled',
          comment: `⛔ Rejected by ${context.userEmail}${input.note ? `: ${input.note}` : ''}.`,
        });
        await this.publishApproval(
          'backoffice.approval.decided',
          {
            ticketId: input.ticketId,
            processCode: payload.processCode,
            scope: payload.scope,
            decision: 'rejected',
            approver: context.userEmail,
            requestedBy: payload.requestedBy,
          },
          context,
        );
        return {
          content: [
            {
              type: 'text',
              text: `⛔ Request **${input.ticketId}** (${payload.processCode}) rejected. The process will not run.`,
            },
          ],
        };
      }

      // Approve → run the routine now, on behalf of the original requester.
      const run = await this.client.runRoutine(payload.routineId, {
        variables: payload.parameters,
        payload: {
          requestedBy: payload.requestedBy,
          approvedBy: context.userEmail,
          processCode: payload.processCode,
          approvalTicket: input.ticketId,
        },
      });
      const runId = String(run.id ?? run.runId ?? '');
      const runTicket = runId ? await this.resolveLinkedTicket(payload.routineId, runId) : null;
      await this.client.updateIssue(input.ticketId, {
        status: 'done',
        comment: `✅ Approved by ${context.userEmail}${input.note ? `: ${input.note}` : ''}. Run started${runTicket ? ` → ${runTicket}` : ''}.`,
      });
      await this.publishApproval(
        'backoffice.approval.decided',
        {
          ticketId: input.ticketId,
          processCode: payload.processCode,
          scope: payload.scope,
          decision: 'approved',
          approver: context.userEmail,
          requestedBy: payload.requestedBy,
          runTicket,
        },
        context,
      );
      const ref = runTicket
        ? `ticket **${runTicket}** — track with henri_ticket_status`
        : `run **${runId || '(queued)'}**`;
      return {
        content: [
          {
            type: 'text',
            text: `✅ Request **${input.ticketId}** (${payload.processCode}) approved — process started as ${ref}.`,
          },
        ],
      };
    } catch (err) {
      this.logger.error({ error: err, ticketId: input.ticketId }, 'Approval decision failed');
      return {
        content: [
          {
            type: 'text',
            text: `Error processing approval: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }

  private async executeListApprovals(context: ToolContext): Promise<CallToolResult> {
    try {
      const issues = await this.client.listCompanyIssues(this.companyId);
      const pending = issues
        .map((i) => ({
          i,
          p: parseApprovalDescription(typeof i.description === 'string' ? i.description : null),
        }))
        .filter(
          ({ i, p }) =>
            p !== null &&
            (i.status ?? 'blocked') === 'blocked' &&
            p.requestedBy.toLowerCase() !== context.userEmail.toLowerCase() &&
            canApprove(context, p.scope),
        );
      if (pending.length === 0) {
        return {
          content: [{ type: 'text', text: 'No approval requests are awaiting your decision.' }],
        };
      }
      const lines = pending.map(
        ({ i, p }) =>
          `- **${String(i.identifier ?? i.shortId ?? i.id)}** — \`${p!.processCode}\` (scope: ${p!.scope ?? 'leadership'}), requested by ${p!.requestedBy}`,
      );
      return {
        content: [
          {
            type: 'text',
            text: `## Approval requests awaiting your decision\n\nDecide with henri_approve.\n\n${lines.join('\n')}`,
          },
        ],
      };
    } catch (err) {
      this.logger.error({ error: err }, 'Failed to list approvals');
      return {
        content: [
          {
            type: 'text',
            text: `Error listing approvals: ${err instanceof Error ? err.message : String(err)}`,
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
