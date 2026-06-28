import { definePlugin } from '@paperclipai/plugin-sdk';
import { BudgetApiClient, readBudgetApiConfig } from './budget-api.js';
import { buildAlertMessage, collectAlerts, diffAlerts, type NotifiedState } from './alerts.js';
import { emitLeadershipChatNotify } from './notify.js';
import { buildSnapshotPayload } from './snapshot.js';
import { emitBudgetSnapshot } from './snapshot-emit.js';

/**
 * Henri budget plugin — registers the budget surveillance cron jobs (alert poll +
 * daily snapshot).
 *
 * NOTE (GRA-42 Step 4 / GRA-46): the three Leadership budget *tools*
 * (henri_budget_status / henri_adjust_budget / henri_resolve_budget) are intentionally
 * NOT registered here. RBAC discovery showed the Paperclip plugin-SDK tool handler
 * receives only `{ agentId }` (no caller groups/permissions) and tool declarations carry
 * no permission field — so this layer cannot enforce the leadership-only (paperclip.budget)
 * gate or emit the per-tool audit. Those tools therefore live in the Henri MCP server
 * (apps/mcp-server `BudgetPlugin`), whose PluginManager filters by `requiredPermission`
 * (resolved from the human caller's RBAC groups via config/rbac.json) and emits
 * `backoffice.audit.tool_invoked` via `auditCategory`. This plugin keeps only the
 * background jobs, which need no caller identity.
 */
const plugin = definePlugin({
  async setup(ctx) {
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
            ctx.logger.warn(
              `budget-alert-poll: EVT publish failed for ${alert.key} (best-effort).`,
            );
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

    ctx.logger.info('Henri budget plugin ready (alert-poll & snapshot jobs)');
  },

  async onHealth() {
    return { status: 'ok', message: 'Henri budget plugin healthy' };
  },
});

export default plugin;
