#!/usr/bin/env node
/**
 * Surgical runtime patch for @paperclipai/server (pinned 2026.609.0).
 *
 * WHY: host→worker RPC calls default to a 30s timeout, and the tool registry
 * dispatches `executeTool` without an override — so any plugin tool call is capped
 * at 30s. Our sandbox tools (`sandbox_run`, `sandbox_code_task`) provision a Sprite,
 * clone, and run commands / Claude, which routinely exceeds 30s. The worker manager
 * already allows a per-call timeout up to MAX_RPC_TIMEOUT_MS (15 min); we just pass
 * it for the executeTool dispatch.
 *
 * Anchored + idempotent: fails the build loudly if Paperclip's internals move.
 * Usage: node patch-paperclip-tool-timeout.mjs   (run after `npm i -g paperclipai`)
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

const MARKER = 'GS_TOOL_RPC_TIMEOUT';
// 15 minutes — the host's MAX_RPC_TIMEOUT_MS (worker manager clamps to this anyway).
const TIMEOUT_MS = 900000;

function findRegistryJs() {
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
    candidates.push(`${root}/@paperclipai/server/dist/services/plugin-tool-registry.js`);
    candidates.push(
      `${root}/paperclipai/node_modules/@paperclipai/server/dist/services/plugin-tool-registry.js`,
    );
  }
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(
    `Could not locate @paperclipai/server plugin-tool-registry.js. Looked in:\n${candidates.join('\n')}`,
  );
}

const ANCHOR = `const result = await workerManager.call(dbId, "executeTool", rpcParams);`;
const REPLACEMENT = `const result = await workerManager.call(dbId, "executeTool", rpcParams, ${TIMEOUT_MS}); /* ${MARKER}: raise tool RPC timeout to the 15min host max */`;

const file = findRegistryJs();
let src = readFileSync(file, 'utf8');

if (src.includes(MARKER)) {
  console.log(`[patch] ${MARKER} already applied to ${file} — skipping.`);
  process.exit(0);
}

const count = src.split(ANCHOR).length - 1;
if (count !== 1) {
  throw new Error(
    `[patch] expected exactly 1 executeTool dispatch anchor in ${file}, found ${count}. ` +
      `The @paperclipai/server internals changed — review and update this patch.`,
  );
}

src = src.replace(ANCHOR, REPLACEMENT);
writeFileSync(file, src);
console.log(`[patch] raised executeTool RPC timeout to ${TIMEOUT_MS}ms in ${file}`);
