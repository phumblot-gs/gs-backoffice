#!/usr/bin/env node
/**
 * Surgical runtime patch for @paperclipai/server (pinned 2026.609.0).
 *
 * WHY: plugin workers receive a curated env, not the full container env. Only the
 * keys in `ADAPTER_ENV_PASSTHROUGH` are passed through (and only for plugins with
 * the `environment.drivers.register` capability). In 2026.609.0 that list is just
 * the LLM keys. Our sandbox tools (`sandbox_run`, `sandbox_code_task`) need the Fly
 * Sprites token and a GitHub token in the worker — and the SDK's other secret paths
 * are unavailable to tools (ctx.secrets.resolve is hard-disabled; ctx.config.get
 * returns unresolved config). So we extend the passthrough to also forward
 * SPRITES_TOKEN + SANDBOX_GITHUB_TOKEN (both injected into the container by
 * Terraform), mirroring how ANTHROPIC_API_KEY already reaches the worker.
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
    // GS sandbox tools: forward the Fly Sprites + GitHub tokens to the worker.
    "SPRITES_TOKEN",
    "SANDBOX_GITHUB_TOKEN",
    "SANDBOX_GITHUB_READ_TOKEN",
    "SANDBOX_GITHUB_PUSH_TOKEN",
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
