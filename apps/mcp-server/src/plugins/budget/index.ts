import { z } from 'zod';
import type { Logger } from 'pino';
import { PaperclipClient } from '../../paperclip-client.js';
import type {
  ServicePlugin,
  PluginTool,
  PluginInitConfig,
  CallToolResult,
} from '../types.js';
import type {
  BudgetOverview,
  UpsertBudgetPolicyBody,
  ResolveBudgetIncidentBody,
} from './types.js';

/** Leadership-only permission (Management Team + Comex) — the canManageBudget rule / config/rbac.json. */
const BUDGET_PERMISSION = 'paperclip.budget';
/** Non-null audit category → PluginManager emits one backoffice.audit.tool_invoked per call. */
const BUDGET_AUDIT_CATEGORY = 'budget';

/**
 * Minimal budget-write surface the tools need. PaperclipClient satisfies it
 * structurally; tests inject a fake to assert bodies/paths without real HTTP.
 */
export interface BudgetClient {
  getBudgetsOverview(companyId: string): Promise<Record<string, unknown>>;
  upsertBudgetPolicy(
    companyId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  resolveBudgetIncident(
    companyId: string,
    incidentId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
}

interface AdjustInput {
  scopeType: 'company' | 'agent' | 'project';
  scopeId: string;
  amount: number;
  metric?: string;
  windowKind?: string;
  warnPercent?: number;
  hardStopEnabled?: boolean;
  notifyEnabled?: boolean;
  isActive?: boolean;
}

interface ResolveInput {
  incidentId: string;
  action: 'raise_budget_and_resume' | 'keep_paused';
  amount?: number;
  decisionNote?: string;
}

/** Build an upsertBudgetPolicySchema-valid body (omit undefined → schema defaults). */
export function buildUpsertBody(input: AdjustInput): UpsertBudgetPolicyBody {
  const body: UpsertBudgetPolicyBody = {
    scopeType: input.scopeType,
    scopeId: input.scopeId,
    amount: input.amount,
  };
  if (input.metric !== undefined) body.metric = input.metric;
  if (input.windowKind !== undefined) body.windowKind = input.windowKind;
  if (input.warnPercent !== undefined) body.warnPercent = input.warnPercent;
  if (input.hardStopEnabled !== undefined) body.hardStopEnabled = input.hardStopEnabled;
  if (input.notifyEnabled !== undefined) body.notifyEnabled = input.notifyEnabled;
  if (input.isActive !== undefined) body.isActive = input.isActive;
  return body;
}

/** Build a resolveBudgetIncidentSchema-valid body from tool args. */
export function buildResolveBody(input: ResolveInput): ResolveBudgetIncidentBody {
  const body: ResolveBudgetIncidentBody = { action: input.action };
  if (input.amount !== undefined) body.amount = input.amount;
  if (input.decisionNote !== undefined) body.decisionNote = input.decisionNote;
  return body;
}

function fmt(n: number | null | undefined): string {
  return typeof n === 'number' ? n.toLocaleString('en-US') : '—';
}

/** Render a readable budget summary from the native overview (tolerant of missing fields). */
export function formatOverview(
  overview: BudgetOverview,
  filter?: { scopeType?: string; scopeId?: string },
): string {
  const policies = (overview.policies ?? []).filter((p) => {
    if (filter?.scopeType && p.scopeType !== filter.scopeType) return false;
    if (filter?.scopeId && p.scopeId !== filter.scopeId) return false;
    return true;
  });
  const incidents = overview.activeIncidents ?? [];
  const lines: string[] = [];
  lines.push(
    `Budget overview — ${policies.length} policy(ies), ${incidents.length} active incident(s).`,
  );
  lines.push(
    `Paused: ${overview.pausedAgentCount ?? 0} agent(s), ${overview.pausedProjectCount ?? 0} project(s).`,
  );
  if (policies.length > 0) {
    lines.push('', 'Policies:');
    for (const p of policies) {
      const util =
        typeof p.utilizationPercent === 'number' ? `${p.utilizationPercent.toFixed(1)}%` : '—';
      lines.push(
        `- [${p.scopeType}] ${p.scopeName ?? p.scopeId} (${p.status ?? 'ok'}): ` +
          `${fmt(p.observedAmount)} / ${fmt(p.amount)} billed_cents (${util} used), ` +
          `remaining ${fmt(p.remainingAmount)}. paused=${p.paused ?? false}`,
      );
    }
  }
  if (incidents.length > 0) {
    lines.push('', 'Active incidents:');
    for (const i of incidents) {
      lines.push(
        `- ${i.id} [${i.scopeType}] ${i.scopeName ?? i.scopeId} — ${i.thresholdType} threshold: ` +
          `observed ${fmt(i.amountObserved)} vs limit ${fmt(i.amountLimit)} (status ${i.status ?? 'open'})`,
      );
    }
  }
  return lines.join('\n');
}

function ok(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}
function err(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/**
 * Leadership-only budget control tools for Henri. Each tool requires `paperclip.budget`
 * (Management Team + Comex) — the PluginManager only registers it into a session whose
 * resolved RBAC permissions include it, so a non-leadership caller is denied — and sets a
 * non-null `auditCategory` so each invocation emits one `backoffice.audit.tool_invoked`.
 * All writes go through the native Paperclip budget API only.
 */
export class BudgetPlugin implements ServicePlugin {
  readonly name = 'budget';
  readonly description =
    'Leadership budget control for Henri: status, policy adjustment, and incident resolution via the native Paperclip budget API.';
  readonly attributionLevel = 2 as const;

  private logger!: Logger;
  private client: BudgetClient | null = null;
  private companyId = '';

  constructor(private readonly injectedClient?: BudgetClient) {}

  async initialize(config: PluginInitConfig): Promise<void> {
    this.logger = config.logger;
    this.companyId = config.credentials.PAPERCLIP_COMPANY_ID ?? '';
    if (this.injectedClient) {
      this.client = this.injectedClient;
      return;
    }
    const apiUrl = config.credentials.PAPERCLIP_API_URL;
    const apiKey = config.credentials.PAPERCLIP_API_KEY;
    if (!apiUrl || !this.companyId) {
      this.logger.warn(
        'Budget plugin: PAPERCLIP_API_URL/PAPERCLIP_COMPANY_ID not set — budget tools will return errors.',
      );
      this.client = null;
      return;
    }
    this.client = new PaperclipClient({ apiUrl, apiKey });
  }

  getTools(): PluginTool[] {
    return [this.statusTool(), this.adjustTool(), this.resolveTool()];
  }

  private statusTool(): PluginTool {
    return {
      name: 'henri_budget_status',
      description:
        'Report current budget consumption: policies (observed/limit/utilization/status), active incidents, and paused agent/project counts. Optionally filter by scope. Leadership only.',
      schema: z.object({
        scopeType: z.enum(['company', 'agent', 'project']).optional(),
        scopeId: z.string().optional(),
      }),
      requiredPermission: BUDGET_PERMISSION,
      auditCategory: BUDGET_AUDIT_CATEGORY,
      execute: async (input) => {
        if (!this.client)
          return err('Budget API is not configured (missing PAPERCLIP_API_URL/COMPANY_ID).');
        try {
          const raw = await this.client.getBudgetsOverview(this.companyId);
          return ok(
            formatOverview(
              raw as unknown as BudgetOverview,
              input as { scopeType?: string; scopeId?: string },
            ),
          );
        } catch (e) {
          return err(`Failed to read budget overview: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    };
  }

  private adjustTool(): PluginTool {
    return {
      name: 'henri_adjust_budget',
      description:
        'Create or update a budget policy for a scope (amount in billed cents, warn %, hard-stop, notify). scopeId must be the scope UUID. Leadership only.',
      schema: z.object({
        scopeType: z.enum(['company', 'agent', 'project']),
        scopeId: z.string().uuid(),
        amount: z.number(),
        metric: z.string().optional(),
        windowKind: z.string().optional(),
        warnPercent: z.number().optional(),
        hardStopEnabled: z.boolean().optional(),
        notifyEnabled: z.boolean().optional(),
        isActive: z.boolean().optional(),
      }),
      requiredPermission: BUDGET_PERMISSION,
      auditCategory: BUDGET_AUDIT_CATEGORY,
      execute: async (input) => {
        if (!this.client) return err('Budget API is not configured.');
        const body = buildUpsertBody(input as AdjustInput);
        try {
          const res = await this.client.upsertBudgetPolicy(this.companyId, body);
          return ok(
            `Budget policy upserted for [${body.scopeType}] ${body.scopeId}: amount ${fmt(body.amount)} billed_cents.\n\n${JSON.stringify(res, null, 2)}`,
          );
        } catch (e) {
          return err(
            `Failed to upsert budget policy: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      },
    };
  }

  private resolveTool(): PluginTool {
    return {
      name: 'henri_resolve_budget',
      description:
        'Resolve a budget incident: keep_paused, or raise_budget_and_resume (optionally with a new amount to raise the cap and resume). Leadership only.',
      schema: z.object({
        incidentId: z.string(),
        action: z.enum(['raise_budget_and_resume', 'keep_paused']),
        amount: z.number().optional(),
        decisionNote: z.string().optional(),
      }),
      requiredPermission: BUDGET_PERMISSION,
      auditCategory: BUDGET_AUDIT_CATEGORY,
      execute: async (input) => {
        if (!this.client) return err('Budget API is not configured.');
        const args = input as ResolveInput;
        const body = buildResolveBody(args);
        try {
          const res = await this.client.resolveBudgetIncident(this.companyId, args.incidentId, body);
          return ok(
            `Budget incident ${args.incidentId} resolved (${body.action}).\n\n${JSON.stringify(res, null, 2)}`,
          );
        } catch (e) {
          return err(
            `Failed to resolve budget incident: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      },
    };
  }
}
