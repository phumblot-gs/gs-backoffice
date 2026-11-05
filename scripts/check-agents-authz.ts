/**
 * CI gate for config/agents-authz.json (run: pnpm exec tsx scripts/check-agents-authz.ts).
 *
 *  1. Schema + policy rules (packages/core agents-authz-rules) — errors fail the job,
 *     warnings (access review due within 20 days) are surfaced as annotations.
 *  2. Static instance posture: no Terraform task definition may set
 *     PAPERCLIP_RUNNER_API_TOOLS_ENABLED to "true" (the drift job cannot observe the
 *     container env from a plugin worker, so this is where that expectation is enforced).
 *
 * Fail-closed: a missing or invalid file is an error, never a skip.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAgentsAuthz } from '../packages/core/src/agents-authz.js';
import { validateAgentsAuthzRules } from '../packages/core/src/agents-authz-rules.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FILE = join(ROOT, 'config', 'agents-authz.json');
const gha = !!process.env.GITHUB_ACTIONS;

function annotate(level: 'error' | 'warning', msg: string): void {
  console.log(
    gha ? `::${level} file=config/agents-authz.json::${msg}` : `${level.toUpperCase()}: ${msg}`,
  );
}

function tfFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (name === '.terraform') return [];
    return statSync(p).isDirectory() ? tfFiles(p) : name.endsWith('.tf') ? [p] : [];
  });
}

let failed = false;
try {
  const cfg = loadAgentsAuthz(FILE);
  const { errors, warnings } = validateAgentsAuthzRules(cfg);
  for (const w of warnings) annotate('warning', `[${w.rule}] ${w.agent ?? ''} ${w.message}`.trim());
  for (const e of errors) {
    annotate(
      'error',
      `[${e.rule}] ${[e.environment, e.agent].filter(Boolean).join('/')} ${e.message}`.trim(),
    );
  }
  failed ||= errors.length > 0;
  console.log(
    `agents-authz: ${Object.keys(cfg.agents).length} agent(s), ${errors.length} error(s), ${warnings.length} warning(s)`,
  );
} catch (err) {
  annotate('error', (err as Error).message);
  failed = true;
}

// PAPERCLIP_RUNNER_API_TOOLS_ENABLED: anything other than "true" disables search_api /
// call_api / hire_agent. Fail if any Terraform file sets it to "true".
const runnerRe = /name\s*=\s*"PAPERCLIP_RUNNER_API_TOOLS_ENABLED"\s*,\s*value\s*=\s*"?true"?/i;
for (const f of tfFiles(join(ROOT, 'infrastructure', 'terraform'))) {
  const text = readFileSync(f, 'utf8');
  if (runnerRe.test(text)) {
    annotate(
      'error',
      `${relative(ROOT, f)} sets PAPERCLIP_RUNNER_API_TOOLS_ENABLED=true (forbidden by agents-authz)`,
    );
    failed = true;
  }
}

process.exit(failed ? 1 : 0);
