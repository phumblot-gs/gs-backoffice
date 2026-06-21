import type { PaperclipPluginManifestV1 } from '@paperclipai/plugin-sdk';

const PLUGIN_ID = 'gs-backoffice.fly-sprites-sandbox-provider';
const PLUGIN_VERSION = '0.1.0';

/**
 * Sandbox provider plugin that runs agent code in Fly Sprites — Firecracker
 * microVMs with EU regions, hibernate-when-idle, and fast checkpoints. Registered
 * as the `fly-sprites` environment driver; the driver is lease-based (see plugin.ts).
 */
const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: 'Fly Sprites Sandbox Provider',
  description:
    'Provisions Fly Sprites (Firecracker microVMs) as isolated Paperclip execution environments.',
  author: 'GRAFMAKER',
  categories: ['automation'],
  // `environment.drivers.register` is also what gates the worker env passthrough
  // (SPRITES_TOKEN / SANDBOX_GITHUB_TOKEN / ANTHROPIC_API_KEY) the sandbox tools rely on.
  capabilities: ['environment.drivers.register', 'agent.tools.register'],
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
        description: 'Env var name holding the GitHub token (default SANDBOX_GITHUB_TOKEN).',
        default: 'SANDBOX_GITHUB_TOKEN',
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
  environmentDrivers: [
    {
      driverKey: 'fly-sprites',
      kind: 'sandbox_provider',
      displayName: 'Fly Sprites',
      description:
        'Runs commands in a Fly Sprite (Firecracker microVM). Sprites hibernate when idle and wake on demand, so leases can be reused cheaply.',
      configSchema: {
        type: 'object',
        properties: {
          apiKey: {
            type: 'string',
            format: 'secret-ref',
            description:
              'Fly Sprites API token (from sprites.dev). Paste a value or a Paperclip secret reference; falls back to SPRITES_TOKEN if omitted.',
          },
          region: {
            type: 'string',
            description: "Fly region to pin the Sprite to (e.g. 'cdg' Paris, 'fra' Frankfurt).",
            default: 'cdg',
          },
          image: {
            type: 'string',
            description: 'Base image/template for the Sprite. Defaults to the provider default.',
          },
          timeoutMs: {
            type: 'number',
            description: 'Per-command timeout in milliseconds. Defaults to 1 hour.',
            default: 3600000,
          },
          reuseLease: {
            type: 'boolean',
            description:
              'Reuse a hibernated Sprite across runs instead of destroying it on release.',
            default: true,
          },
        },
      },
    },
  ],
};

export default manifest;
