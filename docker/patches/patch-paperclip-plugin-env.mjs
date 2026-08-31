#!/usr/bin/env node
/**
 * Surgical runtime patch for @paperclipai/server (pinned 2026.824.1).
 *
 * WHY: plugin workers receive a curated env, not the full container env. Only the
 * keys in `ADAPTER_ENV_PASSTHROUGH` are passed through (and only for plugins with
 * the `environment.drivers.register` capability). In 2026.609.0 that list is just
 * the LLM keys. Our sandbox tools (`sandbox_run`, `sandbox_code_task`) need the Fly
 * Sprites token and a GitHub token in the worker — and the SDK's other secret paths
 * are unavailable to tools (ctx.secrets.resolve is hard-disabled; ctx.config.get
 * returns unresolved config). So we extend the passthrough to also forward
 * SPRITES_TOKEN (injected into the container by Terraform), mirroring how
 * ANTHROPIC_API_KEY already reaches the worker.
 *
 * 2026.824.1 lifted that restriction: ctx.secrets.resolve() now works for plugin
 * tools AND jobs — jobs must pass an explicit companyId, because plugin config is
 * company-scoped. This list is therefore shrinking. A key may leave once (a) the
 * plugin resolves it from a secret reference and (b) a real run has logged
 * "secret resolved from the Paperclip store" for it. Proven for SPRITES_TOKEN on
 * 2026-08-31 at 16:00:12 UTC.
 *
 * Anchored + idempotent: fails the build loudly if Paperclip's internals move.
 * Usage: node patch-paperclip-plugin-env.mjs   (run after `npm i -g paperclipai`)
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

function findPluginLoaderJs() {
  const roots = [];
  try {
    roots.push(execSync('npm root -g', { encoding: 'utf8' }).trim());
  } catch {
    /* ignore */
  }
  roots.push('/usr/local/lib/node_modules', '/usr/lib/node_modules');
  const candidates = [];
  for (const root of roots) {
    if (!root) continue;
    candidates.push(`${root}/@paperclipai/server/dist/services/plugin-loader.js`);
    candidates.push(
      `${root}/paperclipai/node_modules/@paperclipai/server/dist/services/plugin-loader.js`,
    );
  }
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(
    `Could not locate @paperclipai/server plugin-loader.js. Looked in:\n${candidates.join('\n')}`,
  );
}

const ANCHOR = `const ADAPTER_ENV_PASSTHROUGH = [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GOOGLE_API_KEY",
    "GEMINI_API_KEY",
    "OPENROUTER_API_KEY",
];`;

const REPLACEMENT = `const ADAPTER_ENV_PASSTHROUGH = [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GOOGLE_API_KEY",
    "GEMINI_API_KEY",
    "OPENROUTER_API_KEY",
    // GS sandbox tools: forward the Fly Sprites token. Migrating — the plugin now
    // prefers a spritesToken secret reference and only falls back to this.
    "SPRITES_TOKEN",
    // The three SANDBOX_GITHUB_* PATs were removed on 2026-08-31. They were dead:
    // expired, and superseded everywhere by the GitHub App below, which
    // resolveGitHubToken prefers unconditionally. Forwarding an expired credential is
    // not neutral — it is how the PR-review digest posted "aucune PR en attente" every
    // morning for a month. The plugin still accepts them via config for local runs;
    // they simply no longer reach the worker from this container.
    // GitHub App "GRAFMAKER Henri": used by the sandbox tools and the PR-review digest
    // (short-lived installation tokens, nothing to expire).
    "GITHUB_APP_ID",
    "GITHUB_APP_INSTALLATION_ID",
    "GITHUB_APP_PRIVATE_KEY",
    // EVT: the PR-review digest job (plugin worker) publishes notify events.
    // EVT_API_KEY is migrating to an evtApiKey secret reference; the URL and the
    // account id are configuration, not secrets, and stay. Drop EVT_API_KEY once the
    // reference is configured and a digest run has logged the resolution.
    "EVT_API_URL",
    "EVT_API_KEY",
    "EVT_ACCOUNT_ID",
    // Native budget API (GRA-42): the budget plugin worker reads budgets/overview over
    // loopback using the board key, mirroring the mcp-server PaperclipClient convention.
    "PAPERCLIP_API_URL",
    "PAPERCLIP_API_KEY",
    "PAPERCLIP_COMPANY_ID",
];`;

// The passthrough only applies to plugins with `environment.drivers.register`.
// Our sandbox plugin is tools+jobs only (the env driver was retired), so the gate
// must also accept `agent.tools.register` — else the tool worker gets no secrets.
const GATE_ANCHOR = `const canRegisterEnvironmentDrivers = Array.isArray(input.manifest.capabilities)
        && input.manifest.capabilities.includes("environment.drivers.register");`;
const GATE_REPLACEMENT = `const canRegisterEnvironmentDrivers = Array.isArray(input.manifest.capabilities)
        && (input.manifest.capabilities.includes("environment.drivers.register")
            || input.manifest.capabilities.includes("agent.tools.register"));`;

const file = findPluginLoaderJs();
let src = readFileSync(file, 'utf8');

function applyEdit(label, anchor, replacement) {
  if (src.includes(replacement)) {
    console.log(`[patch] ${label} already applied — skipping.`);
    return;
  }
  const count = src.split(anchor).length - 1;
  if (count !== 1) {
    throw new Error(
      `[patch] expected exactly 1 ${label} anchor in ${file}, found ${count}. ` +
        `The @paperclipai/server internals changed — review and update this patch.`,
    );
  }
  src = src.replace(anchor, replacement);
  console.log(`[patch] applied ${label}.`);
}

applyEdit('ADAPTER_ENV_PASSTHROUGH tokens', ANCHOR, REPLACEMENT);
applyEdit('env-passthrough gate (accept agent.tools.register)', GATE_ANCHOR, GATE_REPLACEMENT);
writeFileSync(file, src);
console.log(`[patch] plugin-env patches applied to ${file}`);
