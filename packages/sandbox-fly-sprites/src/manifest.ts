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
  // Secrets reach this worker two ways, in that order of preference:
  //  1. `secrets.read-ref` — the native path. Paperclip 2026.824.1 finally lets a
  //     plugin TOOL call `ctx.secrets.resolve()`; in 2026.609.0 that threw, which is
  //     the only reason the env passthrough patch was written in the first place.
  //  2. The worker env passthrough (docker/patches/patch-paperclip-plugin-env.mjs),
  //     kept as a fallback so this migration deploys without a config change.
  // The patch cannot be retired until the EVT and Paperclip API keys move over too.
  capabilities: [
    'agent.tools.register',
    'jobs.schedule',
    'plugin.state.read',
    'plugin.state.write',
    'secrets.read-ref',
  ],
  // Idle reaper: hourly job that deletes sandbox Sprites idle beyond the TTL.
  jobs: [
    {
      jobKey: 'sandbox-reaper',
      displayName: 'Sandbox idle reaper',
      description: 'Delete sandbox Sprites idle beyond the configured TTL (default 7 days).',
      schedule: '0 * * * *',
    },
    {
      jobKey: 'pr-review-digest',
      displayName: 'PR review digest',
      description:
        'Weekday-morning Google Chat digest of open PRs awaiting review (cron UTC; 06:00 = 08:00 Paris in summer / 07:00 in winter).',
      schedule: '0 6 * * 1-5',
    },
  ],
  entrypoints: {
    worker: './dist/worker.js',
  },
  // Operator config for the sandbox tools.
  //
  // The `*Token` fields hold Paperclip secret REFERENCES (`format: 'secret-ref'`) —
  // never a value. They are resolved at call time via `ctx.secrets.resolve()`.
  //
  // Deliberately no `type`. The board's secret picker submits an EnvSecretRefBinding
  // OBJECT — `{ type: 'secret_ref', secretId, version }` — so declaring `type: 'string'`
  // made Ajv reject every save with "Configuration does not match the plugin's
  // instanceConfigSchema". `format` alone still drives the picker, and Ajv applies a
  // format only to strings, so both the object and a bare UUID pass.
  // The `*Env` fields below are the legacy path: env-var NAMES read from the worker
  // env passthrough. A reference wins when both are set; the env name is the fallback
  // so nothing breaks before an operator fills the references in.
  instanceConfigSchema: {
    type: 'object',
    properties: {
      spritesToken: {
        format: 'secret-ref',
        description:
          'Fly Sprites API token, as a Paperclip secret reference. Preferred over spritesTokenEnv.',
      },
      githubToken: {
        format: 'secret-ref',
        description:
          'Combined GitHub token as a secret reference, used when no read/push split is set. Preferred over githubTokenEnv.',
      },
      githubReadToken: {
        format: 'secret-ref',
        description:
          'Read-only GitHub token as a secret reference. Preferred over githubReadTokenEnv.',
      },
      githubPushToken: {
        format: 'secret-ref',
        description:
          'Push-capable GitHub token as a secret reference. Preferred over githubPushTokenEnv.',
      },
      anthropicKey: {
        format: 'secret-ref',
        description: 'Anthropic API key as a secret reference. Preferred over anthropicKeyEnv.',
      },
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
          model: {
            type: 'string',
            description:
              'Claude model for the in-sandbox coding run. Defaults to Sonnet; pass a Haiku model for trivial edits to save cost.',
          },
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
