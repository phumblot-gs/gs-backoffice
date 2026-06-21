#!/usr/bin/env node
/**
 * Surgical runtime patch for @paperclipai/server (pinned 2026.609.0).
 *
 * WHY: when a sandbox-bound agent run fails with `process_lost` (the Fly Sprites
 * exec transport intermittently drops long-lived processes), Paperclip's recovery
 * re-run re-resolves the execution environment from scratch and silently falls back
 * to the instance's Local default instead of the environment the originating run was
 * bound to. The work then runs on Local, defeating the sandbox isolation.
 *
 * FIX: for any run created as a retry (`retryOfRunId` set), inherit the environment
 * the ORIGINATING run resolved (walking the retry lineage), overriding the fallback.
 * Strictly scoped to this run's own ancestry, so it can never borrow another issue's
 * environment. A dead sandbox VM is fine — downstream lease acquisition provisions a
 * fresh lease on the inherited environment.
 *
 * This edits the installed compiled JS in place (the package ships unbundled dist/).
 * Idempotent and anchored: it fails loudly if the expected code is not found, so a
 * Paperclip upgrade that moves this code surfaces immediately at build time.
 *
 * Usage: node patch-paperclip-retry-env.mjs   (run after `npm i -g paperclipai`)
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

const MARKER = 'GS_RETRY_ENV_PIN_V1';

function findHeartbeatJs() {
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
    // Hoisted layout, then nested-under-paperclipai layout (what npm i -g produces).
    candidates.push(`${root}/@paperclipai/server/dist/services/heartbeat.js`);
    candidates.push(
      `${root}/paperclipai/node_modules/@paperclipai/server/dist/services/heartbeat.js`,
    );
  }
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // Last resort: require.resolve from the global root (stderr silenced — a miss here
  // is expected and handled, we don't want it polluting the build log).
  try {
    const root = execSync('npm root -g', { encoding: 'utf8' }).trim();
    const resolved = execSync(
      `node -e "process.stdout.write(require.resolve('@paperclipai/server/dist/services/heartbeat.js',{paths:['${root}']}))"`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (resolved && existsSync(resolved)) return resolved;
  } catch {
    /* ignore */
  }
  throw new Error(
    `Could not locate @paperclipai/server heartbeat.js. Looked in:\n${candidates.join('\n')}`,
  );
}

const ANCHOR = `const environmentResolution = resolveExecutionWorkspaceEnvironmentId({
                projectPolicy: projectExecutionWorkspacePolicy,
                issueSettings: issueExecutionWorkspaceSettings,
                workspaceConfig: requestedReusableExecutionWorkspaceConfig,
                agentDefaultEnvironmentId: agent.defaultEnvironmentId,
                defaultEnvironmentId: defaultEnvironment.id,
            });`;

const INJECTION = `
            // ${MARKER}: pin a recovery/retry run to the environment its originating
            // run resolved, instead of silently falling back to the local default.
            if (run.retryOfRunId) {
                try {
                    let __gsOriginId = run.retryOfRunId;
                    let __gsInheritedEnvId = null;
                    for (let __gsHops = 0; __gsHops < 10 && __gsOriginId; __gsHops += 1) {
                        const __gsOrigin = await db
                            .select({ contextSnapshot: heartbeatRuns.contextSnapshot, retryOfRunId: heartbeatRuns.retryOfRunId })
                            .from(heartbeatRuns)
                            .where(eq(heartbeatRuns.id, __gsOriginId))
                            .then((rows) => rows[0] ?? null);
                        if (!__gsOrigin) break;
                        const __gsEnvId = readNonEmptyString(parseObject(__gsOrigin.contextSnapshot)?.paperclipEnvironment?.id);
                        if (__gsEnvId && __gsEnvId !== defaultEnvironment.id) { __gsInheritedEnvId = __gsEnvId; break; }
                        __gsOriginId = __gsOrigin.retryOfRunId;
                    }
                    if (__gsInheritedEnvId && __gsInheritedEnvId !== environmentResolution.environmentId) {
                        logger.warn({ runId: run.id, issueId, retryOfRunId: run.retryOfRunId, inheritedEnvironmentId: __gsInheritedEnvId, resolvedEnvironmentId: environmentResolution.environmentId }, "${MARKER}: pinning recovery/retry run to originating run environment");
                        environmentResolution.environmentId = __gsInheritedEnvId;
                        environmentResolution.source = "retry_inherited";
                        environmentResolution.conflict = null;
                    }
                } catch (__gsErr) {
                    logger.warn({ runId: run.id, error: __gsErr instanceof Error ? __gsErr.message : String(__gsErr) }, "${MARKER}: failed to inherit originating run environment; using resolved environment");
                }
            }`;

const file = findHeartbeatJs();
let src = readFileSync(file, 'utf8');

if (src.includes(MARKER)) {
  console.log(`[patch] ${MARKER} already applied to ${file} — skipping.`);
  process.exit(0);
}

const count = src.split(ANCHOR).length - 1;
if (count !== 1) {
  throw new Error(
    `[patch] expected exactly 1 occurrence of the environmentResolution anchor in ${file}, found ${count}. ` +
      `The @paperclipai/server internals changed — review and update this patch.`,
  );
}

src = src.replace(ANCHOR, ANCHOR + INJECTION);
writeFileSync(file, src);
console.log(`[patch] applied ${MARKER} to ${file}`);
