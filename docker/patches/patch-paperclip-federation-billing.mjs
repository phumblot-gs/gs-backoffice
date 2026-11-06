#!/usr/bin/env node
/**
 * Surgical runtime patch for @paperclipai/adapter-claude-local (pinned 2026.824.1).
 *
 * WHY: the claude_local adapter infers how a run is billed from the presence of
 * ANTHROPIC_API_KEY alone: key present → "api" (metered), absent → "subscription".
 * Under workload identity federation (docs/architecture/anthropic-federation.md) there
 * is deliberately NO static key, so every run is labelled "subscription", which the
 * server normalises to "subscription_included" and books at **0 cents**
 * (heartbeat.js normalizeBilledCostCents). Budgets then never see agent spend.
 * Observed on staging 2026-11-06: an Engineer run reported costUsd 0.168 and the
 * agent's spentMonthlyCents did not move.
 *
 * Federated tokens are metered API usage on our organization, so the presence of
 * ANTHROPIC_FEDERATION_RULE_ID now also yields "api". Nothing else changes: an API key
 * still means "api", Bedrock still means "metered_api", and no credential still means
 * "subscription".
 *
 * Anchored + idempotent: fails the build loudly if the adapter's internals move.
 * Usage: node patch-paperclip-federation-billing.mjs   (run after `npm i -g paperclipai`)
 *        PAPERCLIP_CLAUDE_ADAPTER_DIR=<dir>/dist/server node …   (tests)
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const MARKER = 'GS_FEDERATION_BILLING';

function findAdapterDir() {
  if (process.env.PAPERCLIP_CLAUDE_ADAPTER_DIR) return process.env.PAPERCLIP_CLAUDE_ADAPTER_DIR;
  const roots = [];
  try {
    roots.push(execSync('npm root -g', { encoding: 'utf8' }).trim());
  } catch {
    /* ignore */
  }
  roots.push('/usr/local/lib/node_modules', '/usr/lib/node_modules');
  const candidates = roots.flatMap((r) => [
    `${r}/paperclipai/node_modules/@paperclipai/adapter-claude-local/dist/server`,
    `${r}/@paperclipai/adapter-claude-local/dist/server`,
  ]);
  for (const c of candidates) if (existsSync(join(c, 'execute.js'))) return c;
  throw new Error(
    `Could not locate adapter-claude-local dist/server. Looked in:\n${candidates.join('\n')}`,
  );
}

function patchFile(file, label, anchor, replacement) {
  let src = readFileSync(file, 'utf8');
  if (src.includes(MARKER)) {
    console.log(`[patch] ${label} already applied — skipping.`);
    return;
  }
  const count = src.split(anchor).length - 1;
  if (count !== 1) {
    throw new Error(
      `[patch] expected exactly 1 ${label} anchor in ${file}, found ${count}. ` +
        'The adapter internals changed — review and update this patch.',
    );
  }
  src = src.replace(anchor, replacement);
  writeFileSync(file, src);
  console.log(`[patch] applied ${label}.`);
}

const dir = findAdapterDir();

// CLI engine (execute.js) — the path our claude_local agents use.
patchFile(
  join(dir, 'execute.js'),
  'execute.js billing type',
  `    return hasNonEmptyEnvValue(env, "ANTHROPIC_API_KEY") ? "api" : "subscription";`,
  `    // ${MARKER}: workload identity federation is metered API usage, not a subscription.
    if (hasNonEmptyEnvValue(env, "ANTHROPIC_FEDERATION_RULE_ID"))
        return "api";
    return hasNonEmptyEnvValue(env, "ANTHROPIC_API_KEY") ? "api" : "subscription";`,
);

// ACP engine (acp.js) — same inference, kept consistent.
patchFile(
  join(dir, 'acp.js'),
  'acp.js billing type',
  `        : readEnvValue("ANTHROPIC_API_KEY")
            ? "api"
            : "subscription";`,
  `        : (readEnvValue("ANTHROPIC_API_KEY") || readEnvValue("ANTHROPIC_FEDERATION_RULE_ID")) // ${MARKER}
            ? "api"
            : "subscription";`,
);

console.log(`[patch] federation billing patches applied in ${dir}`);
