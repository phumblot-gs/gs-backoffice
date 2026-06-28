import { definePlugin } from '@paperclipai/plugin-sdk';
import type { ToolResult } from '@paperclipai/plugin-sdk';

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

    // Cron jobs — empty-body stubs this step (no-op until GRA-42 Step 2).
    ctx.jobs.register('budget-alert-poll', async () => {
      ctx.logger.info('budget-alert-poll: stub (no-op until GRA-42 Step 2)');
    });
    ctx.jobs.register('budget-snapshot', async () => {
      ctx.logger.info('budget-snapshot: stub (no-op until GRA-42 Step 2)');
    });

    ctx.logger.info('Henri budget plugin ready (stubs: 3 tools + alert/snapshot jobs)');
  },

  async onHealth() {
    return { status: 'ok', message: 'Henri budget plugin healthy' };
  },
});

export default plugin;
