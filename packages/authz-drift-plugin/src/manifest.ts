import type { PaperclipPluginManifestV1 } from '@paperclipai/plugin-sdk';

/**
 * Agent-authz drift detector (docs/architecture/agents-authz.md).
 *
 * READ-ONLY BY CAPABILITY: the manifest requests only `*.read` data capabilities, so the
 * host itself refuses any write this worker might attempt — the guarantee does not rest
 * on the code alone. It never asks for `agent.tools.register`, so the env-passthrough
 * patch does not apply to it: credentials come from secret references in config.
 */
const manifest: PaperclipPluginManifestV1 = {
  id: 'gs-backoffice.authz-drift',
  apiVersion: 1,
  version: '0.1.0',
  displayName: 'Agent authorizations — drift detection',
  description:
    "Compares Paperclip's real agent authorizations with config/agents-authz.json (read-only) and alerts on any difference.",
  author: 'GRAFMAKER',
  categories: ['automation'],
  capabilities: [
    'jobs.schedule',
    'companies.read',
    'agents.read',
    'authorization.grants.read',
    'secrets.read-ref',
  ],
  jobs: [
    {
      jobKey: 'authz-drift-check',
      displayName: 'Agent authz drift check',
      description:
        'Daily read-only comparison of agent permissions, grants, trust presets, approval modes and the company hiring gate against config/agents-authz.json (cron UTC 05:00). Can also be run on demand from the board.',
      schedule: '0 5 * * *',
    },
  ],
  entrypoints: {
    worker: './dist/worker.js',
  },
  // Company-scoped config. `environment` declares which section of the file this company
  // is checked against. The EVT key is a secret REFERENCE (no `type`, see the sandbox
  // plugin manifest for why) resolved at run time; URL and account id are not secrets.
  instanceConfigSchema: {
    type: 'object',
    properties: {
      environment: {
        type: 'string',
        enum: ['staging', 'production'],
        description:
          'Which environment section of agents-authz.json this company is checked against.',
      },
      authzPath: {
        type: 'string',
        description:
          'Path of the baked agents-authz.json (default /opt/gs-agent-tools/agents-authz.json).',
        default: '/opt/gs-agent-tools/agents-authz.json',
      },
      evtApiUrl: { type: 'string', description: 'EVT API base URL.' },
      evtAccountId: { type: 'string', description: 'EVT account id.' },
      evtApiKey: {
        format: 'secret-ref',
        description: 'EVT API key, as a Paperclip secret reference.',
      },
      chatScope: {
        type: 'string',
        description: 'Google Chat notification scope for drift alerts (default leadership).',
        default: 'leadership',
      },
    },
  },
  tools: [],
};

export default manifest;
