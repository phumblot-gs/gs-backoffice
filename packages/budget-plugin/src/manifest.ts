import type { PaperclipPluginManifestV1 } from '@paperclipai/plugin-sdk';

const PLUGIN_ID = 'gs-backoffice.budget';
const PLUGIN_VERSION = '0.1.0';

/**
 * Henri budget surveillance plugin (GRA-42). Declares only the two cron jobs
 * (budget-alert-poll, budget-snapshot). The three Leadership budget tools
 * (henri_budget_status / henri_adjust_budget / henri_resolve_budget) now live in the
 * Henri MCP server (apps/mcp-server BudgetPlugin), which can enforce the leadership-only
 * RBAC gate and per-tool audit — see GRA-42 Step 4 / GRA-46. No secrets live in the
 * manifest — EVT creds reach the worker via the env passthrough patch.
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
  capabilities: ['jobs.schedule', 'plugin.state.read', 'plugin.state.write'],
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
  tools: [],
};

export default manifest;
