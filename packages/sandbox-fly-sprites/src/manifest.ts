import type { PaperclipPluginManifestV1 } from '@paperclipai/plugin-sdk';

const PLUGIN_ID = 'gs-backoffice.fly-sprites-sandbox-provider';
const PLUGIN_VERSION = '0.1.0';

/**
 * Fly Sprites sandbox plugin. Exposes the sandbox TOOLS (sandbox_run,
 * sandbox_code_task, sandbox_release) + an idle reaper job. Agents drive the
 * sandbox via tools (agent on Local calls a tool), not by running "on" a sandbox
 * environment — the legacy environment driver has been retired.
 * See docs/architecture/sandbox-code-tool.md.
 */
const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: 'Fly Sprites Sandbox Tools',
  description:
    'Agent tools to run commands and Claude coding tasks in isolated Fly Sprite microVMs (sandbox_run, sandbox_code_task, sandbox_release), with an idle reaper.',
  author: 'GRAFMAKER',
  categories: ['automation'],
  // The worker env passthrough (SPRITES_TOKEN / SANDBOX_GITHUB_* / ANTHROPIC_API_KEY)
  // is gated on `agent.tools.register` by our plugin-env patch (the env driver, which
  // previously satisfied that gate, has been retired).
  capabilities: [
    'agent.tools.register',
    'jobs.schedule',
    'plugin.state.read',
    'plugin.state.write',
  ],
  // Idle reaper: hourly job that deletes sandbox Sprites idle beyond the TTL.
  jobs: [
    {
      jobKey: 'sandbox-reaper',
      displayName: 'Sandbox idle reaper',
      description: 'Delete sandbox Sprites idle beyond the configured TTL (default 7 days).',
      schedule: '0 * * * *',
    },
  ],
  entrypoints: {
    worker: './dist/worker.js',
  },
  // Operator config for the sandbox tools. Secrets are NOT here — they reach the
  // worker via the env passthrough (see docker/patches/patch-paperclip-plugin-env.mjs);
  // these fields only let an operator override the env-var NAMES and defaults.
  instanceConfigSchema: {
    type: 'object',
    properties: {
      spritesTokenEnv: {
        type: 'string',
        description: 'Env var name holding the Fly Sprites API token (default SPRITES_TOKEN).',
        default: 'SPRITES_TOKEN',
      },
      githubTokenEnv: {
        type: 'string',
        description:
          'Env var name for the combined GitHub token, used when no read/push split is set (default SANDBOX_GITHUB_TOKEN).',
        default: 'SANDBOX_GITHUB_TOKEN',
      },
      githubReadTokenEnv: {
        type: 'string',
        description:
          'Env var name for a read-only GitHub token (verification / sandbox_run). Falls back to the combined token.',
        default: 'SANDBOX_GITHUB_READ_TOKEN',
      },
      githubPushTokenEnv: {
        type: 'string',
        description:
          'Env var name for a push-capable GitHub token (sandbox_code_task). Falls back to the combined token.',
        default: 'SANDBOX_GITHUB_PUSH_TOKEN',
      },
      reaperTtlDays: {
        type: 'number',
        description:
          'Idle-reaper TTL in days: sandboxes unused longer than this are deleted (default 7).',
        default: 7,
      },
      region: {
        type: 'string',
        description: "Fly region for sandbox tool Sprites (e.g. 'cdg').",
        default: 'cdg',
      },
      timeoutMs: {
        type: 'number',
        description: 'Default per-command timeout for sandbox tools (ms).',
        default: 3600000,
      },
    },
  },
  tools: [
    {
      name: 'sandbox_run',
      displayName: 'Run a command in a sandbox',
      description:
        'Run an arbitrary command in an isolated, reusable Fly Sprite microVM with a repo checked out at a given git ref, and return the captured exit code + output. For verification: tests, code scanners, pentest tools, lint, build. Reuses the sandbox keyed by `sandboxKey`; does not push.',
      parametersSchema: {
        type: 'object',
        required: ['sandboxKey', 'repoUrl', 'ref', 'command'],
        additionalProperties: false,
        properties: {
          sandboxKey: {
            type: 'string',
            description:
              'Stable id scoping Sprite reuse, tied to repo + role (e.g. "audit-GRA-12"). Same key reuses the same microVM; distinct keys never share a sandbox.',
          },
          repoUrl: { type: 'string', description: 'Git URL to clone (per project).' },
          ref: {
            type: 'string',
            description: 'Branch name or commit SHA to check out before running.',
          },
          command: {
            type: 'string',
            description:
              'Command to run in the repo dir (via `sh -c`), e.g. "pnpm test". Does not push.',
          },
          credMode: {
            type: 'string',
            enum: ['read_only', 'push'],
            default: 'read_only',
            description: 'Which GitHub credential to expose to git in the sandbox.',
          },
          timeoutMs: { type: 'number', description: 'Hard wall-clock limit for the command (ms).' },
        },
      },
    },
    {
      name: 'sandbox_code_task',
      displayName: 'Run a coding task with Claude in a sandbox',
      description:
        'Run Claude in an isolated, reusable Fly Sprite to perform a coding task on a branch, then commit and push the result to GitHub from inside the sandbox. Reuses the sandbox keyed by `sandboxKey` (re-invoke to iterate). Returns branch, head SHA, and Claude’s summary.',
      parametersSchema: {
        type: 'object',
        required: ['sandboxKey', 'repoUrl', 'targetBranch', 'task'],
        additionalProperties: false,
        properties: {
          sandboxKey: {
            type: 'string',
            description: 'Stable id scoping Sprite reuse (tie to repo + issue, e.g. "eng-GRA-12").',
          },
          repoUrl: { type: 'string', description: 'Git URL to clone (per project).' },
          baseBranch: {
            type: 'string',
            description: 'Branch to start from when the target branch is new (default "main").',
          },
          targetBranch: { type: 'string', description: 'Branch to commit + push the work to.' },
          task: {
            type: 'string',
            description: 'Instruction for Claude (it edits files; the tool commits + pushes).',
          },
          model: { type: 'string', description: 'Optional Claude model for the in-sandbox run.' },
          timeoutMs: {
            type: 'number',
            description: 'Hard wall-clock limit (ms; host caps at 15min).',
          },
        },
      },
    },
    {
      name: 'sandbox_release',
      displayName: 'Release (delete) a sandbox',
      description:
        'Delete the Fly Sprite for a `sandboxKey`. Call when the work is done; the durable result is the pushed branch/PR, so this loses nothing.',
      parametersSchema: {
        type: 'object',
        required: ['sandboxKey'],
        additionalProperties: false,
        properties: {
          sandboxKey: {
            type: 'string',
            description: 'The sandbox to release (same key used to run it).',
          },
        },
      },
    },
  ],
};

export default manifest;
