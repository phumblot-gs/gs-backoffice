import type { PaperclipPluginManifestV1 } from '@paperclipai/plugin-sdk';

const PLUGIN_ID = 'gs-backoffice.budget';
const PLUGIN_VERSION = '0.1.0';

/**
 * Henri budget surveillance & adjustment plugin (GRA-42). Declares two cron jobs
 * (budget-alert-poll, budget-snapshot) and three agent tools
 * (henri_budget_status / henri_adjust_budget / henri_resolve_budget). Job and tool
 * bodies are stubs this step (GRA-42 Step 1); logic lands in Steps 2–4. No secrets
 * live in the manifest — EVT creds reach the worker via the env passthrough patch.
 */
const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: 'Henri Budget Surveillance',
  description:
    'Budget surveillance & adjustment for Henri: alert polling, daily snapshots, and budget status/adjust/resolve tools.',
  author: 'GRAFMAKER',
  categories: ['automation'],
  capabilities: [
    'agent.tools.register',
    'jobs.schedule',
    'plugin.state.read',
    'plugin.state.write',
  ],
  jobs: [
    {
      jobKey: 'budget-alert-poll',
      displayName: 'Budget alert poll',
      description:
        'Poll budget usage and raise alerts when warn / hard-stop thresholds are crossed (short interval).',
      schedule: '*/5 * * * *',
    },
    {
      jobKey: 'budget-snapshot',
      displayName: 'Daily budget snapshot',
      description: 'Capture a daily snapshot of budget consumption per scope (cron UTC 06:00).',
      schedule: '0 6 * * *',
    },
  ],
  entrypoints: {
    worker: './dist/worker.js',
  },
  tools: [
    {
      name: 'henri_budget_status',
      displayName: 'Henri budget status',
      description:
        'Report current budget consumption and policy status for a scope (company/agent/project). Not implemented yet (GRA-42 Step 2).',
      parametersSchema: {
        type: 'object',
        required: ['scopeType', 'scopeId'],
        additionalProperties: false,
        properties: {
          scopeType: {
            type: 'string',
            enum: ['company', 'agent', 'project'],
            description: 'Budget scope type.',
          },
          scopeId: { type: 'string', description: 'Identifier of the scoped entity.' },
        },
      },
    },
    {
      name: 'henri_adjust_budget',
      displayName: 'Henri adjust budget',
      description:
        'Create or update a budget policy for a scope (amount, thresholds, hard-stop). Not implemented yet (GRA-42 Step 3).',
      parametersSchema: {
        type: 'object',
        required: ['scopeType', 'scopeId', 'amount'],
        additionalProperties: false,
        properties: {
          scopeType: { type: 'string', enum: ['company', 'agent', 'project'] },
          scopeId: { type: 'string' },
          amount: { type: 'number', description: 'Budget amount in billed cents.' },
          warnPercent: { type: 'number' },
          hardStopEnabled: { type: 'boolean' },
          notifyEnabled: { type: 'boolean' },
          isActive: { type: 'boolean' },
        },
      },
    },
    {
      name: 'henri_resolve_budget',
      displayName: 'Henri resolve budget incident',
      description:
        'Resolve a budget incident: keep paused, or raise the budget and resume. Not implemented yet (GRA-42 Step 4).',
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
  ],
};

export default manifest;
