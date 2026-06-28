import { definePlugin } from '@paperclipai/plugin-sdk';
import type { ToolResult } from '@paperclipai/plugin-sdk';
import { BudgetApiClient, readBudgetApiConfig } from './budget-api.js';
import { buildAlertMessage, collectAlerts, diffAlerts, type NotifiedState } from './alerts.js';
import { emitLeadershipChatNotify } from './notify.js';
import { buildSnapshotPayload } from './snapshot.js';
import { emitBudgetSnapshot } from './snapshot-emit.js';

/** Stub tool result this step — real logic lands in GRA-42 Steps 2–4. */
const notImplemented = (tool: string, step: string): ToolResult => ({
  error: `${tool} is not implemented yet (GRA-42 ${step}).`,
});

/**
 * Henri budget plugin — registers three budget tools and two cron jobs.
 * Tool handlers and job bodies are stubs this step (GRA-42 Step 1): they compile
 * and load so the plugin can be baked + activated; the surveillance/adjustment
 * logic is added in Steps 2–4.
 */
const plugin = definePlugin({
  async setup(ctx) {
    ctx.tools.register(
      'henri_budget_status',
      {
        displayName: 'Henri budget status',
        description:
          'Report current budget consumption and policy status for a scope (company/agent/project).',
        parametersSchema: {
          type: 'object',
          required: ['scopeType', 'scopeId'],
          additionalProperties: false,
          properties: {
            scopeType: { type: 'string', enum: ['company', 'agent', 'project'] },
            scopeId: { type: 'string' },
          },
        },
      },
      async (): Promise<ToolResult> => notImplemented('henri_budget_status', 'Step 2'),
    );

    ctx.tools.register(
      'henri_adjust_budget',
      {
        displayName: 'Henri adjust budget',
        description: 'Create or update a budget policy for a scope (amount, thresholds, hard-stop).',
        parametersSchema: {
          type: 'object',
          required: ['scopeType', 'scopeId', 'amount'],
          additionalProperties: false,
          properties: {
            scopeType: { type: 'string', enum: ['company', 'agent', 'project'] },
            scopeId: { type: 'string' },
            amount: { type: 'number' },
            warnPercent: { type: 'number' },
            hardStopEnabled: { type: 'boolean' },
            notifyEnabled: { type: 'boolean' },
            isActive: { type: 'boolean' },
          },
        },
      },
      async (): Promise<ToolResult> => notImplemented('henri_adjust_budget', 'Step 3'),
    );

    ctx.tools.register(
      'henri_resolve_budget',
      {
        displayName: 'Henri resolve budget incident',
        description: 'Resolve a budget incident: keep paused, or raise the budget and resume.',
        parametersSchema: {
          type: 'object',
          required: ['action'],
          additionalProperties: false,
          properties: {
            action: { type: 'string', enum: ['keep_paused', 'raise_budget_and_resume'] },
            amount: { type: 'number' },
            decisionNote: { type: 'string' },
          },
        },
      },
      async (): Promise<ToolResult> => notImplemented('henri_resolve_budget', 'Step 4'),
    );

    // budget-alert-poll (GRA-42 Step 2): poll budgets/overview, alert Leadership on each
    // active incident (soft + hard) and each scope newly paused for budget. Deduped via
    // plugin.state so the same open incident is not re-notified every 5 min; a soft→hard
    // escalation re-notifies once. Entirely best-effort — never throws.
    ctx.jobs.register('budget-alert-poll', async () => {
      try {
        const config = readBudgetApiConfig(process.env);
        if (!config) {
          ctx.logger.warn(
            'budget-alert-poll: PAPERCLIP_API_URL/PAPERCLIP_COMPANY_ID not in worker env — skipping (see ADAPTER_ENV_PASSTHROUGH patch).',
          );
          return;
        }
        const overview = await new BudgetApiClient(config).getBudgetsOverview();
        if (!overview) {
          ctx.logger.warn('budget-alert-poll: budgets/overview unavailable — skipping this run.');
          return;
        }
        const current = collectAlerts(overview);
        const stateRef = {
          scopeKind: 'instance' as const,
          namespace: 'budget-alerts',
          stateKey: 'notified',
        };
        const prior = ((await ctx.state.get(stateRef)) as NotifiedState | null) ?? {};
        const { toNotify, nextState } = diffAlerts(current, prior);
        for (const alert of toNotify) {
          const sent = await emitLeadershipChatNotify(buildAlertMessage(alert), process.env);
          if (!sent) {
            ctx.logger.warn(`budget-alert-poll: EVT publish failed for ${alert.key} (best-effort).`);
          }
        }
        await ctx.state.set(stateRef, nextState);
        ctx.logger.info(
          `budget-alert-poll: ${current.length} active alert(s), ${toNotify.length} newly notified.`,
        );
      } catch (err) {
        ctx.logger.warn(`budget-alert-poll: failed (best-effort, ignored): ${String(err)}`);
      }
    });
    // budget-snapshot (GRA-42 Step 3): once daily, read budgets/overview + costs/by-agent +
    // costs/by-project, merge into ONE aggregated snapshot of EVERY agent & project, and emit a
    // single backoffice.budget.snapshot event (BI data — the notify-consumer does NOT subscribe).
    // Entirely best-effort — never throws.
    ctx.jobs.register('budget-snapshot', async () => {
      try {
        const config = readBudgetApiConfig(process.env);
        if (!config) {
          ctx.logger.warn(
            'budget-snapshot: PAPERCLIP_API_URL/PAPERCLIP_COMPANY_ID not in worker env — skipping (see ADAPTER_ENV_PASSTHROUGH patch).',
          );
          return;
        }
        const client = new BudgetApiClient(config);
        const [overview, costsByAgent, costsByProject] = await Promise.all([
          client.getBudgetsOverview(),
          client.getCostsByAgent(),
          client.getCostsByProject(),
        ]);
        if (!overview) {
          ctx.logger.warn('budget-snapshot: budgets/overview unavailable — skipping this run.');
          return;
        }
        // reportDate = today UTC (YYYY-MM-DD); window = the company budget window from overview.
        const reportDate = new Date().toISOString().slice(0, 10);
        const companyPolicy = (overview.policies ?? []).find((p) => p.scopeType === 'company');
        const window = {
          windowStart: companyPolicy?.windowStart ?? null,
          windowEnd: companyPolicy?.windowEnd ?? null,
        };
        const payload = buildSnapshotPayload({
          overview,
          costsByAgent,
          costsByProject,
          reportDate,
          window,
        });
        const sent = await emitBudgetSnapshot(payload, process.env);
        ctx.logger.info(
          `budget-snapshot: ${payload.agents.length} agent(s), ${payload.projects.length} project(s) for ${reportDate} — ${sent ? 'emitted backoffice.budget.snapshot' : 'EVT publish skipped/failed (best-effort)'}.`,
        );
      } catch (err) {
        ctx.logger.warn(`budget-snapshot: failed (best-effort, ignored): ${String(err)}`);
      }
    });

    ctx.logger.info('Henri budget plugin ready (3 tool stubs + alert-poll & snapshot jobs)');
  },

  async onHealth() {
    return { status: 'ok', message: 'Henri budget plugin healthy' };
  },
});

export default plugin;
