/**
 * EVT emission from the bridge — used to notify (via the notify-consumer → Google
 * Chat) when a PR needs human review. Publishes through the shared
 * `@gs-backoffice/evt-client` (`EvtClient`) + `createBackofficeEvent` so the bridge,
 * the digest job, and the employee-facing MCP server all share ONE event definition
 * and emission path (esbuild inlines these workspace packages into the baked bundle).
 *
 * The notify-consumer handles `backoffice.notify.google_chat` (payload `{text, scope}`)
 * and routes the scope to its Chat channel, falling back to "general". The per-repo
 * scope is configured in config/rbac.json (`repos`), baked at /opt/gs-agent-tools/rbac.json.
 * Emission is best-effort: a notify failure must never fail the tool call.
 */
import { readFileSync } from 'node:fs';
import { EvtClient } from '@gs-backoffice/evt-client';
import { createBackofficeEvent } from '@gs-backoffice/core';

const RBAC_PATH = (process.env.GS_RBAC_PATH || '/opt/gs-agent-tools/rbac.json').trim();

let cachedRepos: Record<string, string> | null | undefined;

/** Notify scope for a repo ("owner/repo") from the baked rbac.json; default "general". */
export function resolveNotifyScope(repo: string, rbacPath: string = RBAC_PATH): string {
  if (cachedRepos === undefined) {
    try {
      const raw = JSON.parse(readFileSync(rbacPath, 'utf8')) as { repos?: Record<string, string> };
      cachedRepos = raw.repos && typeof raw.repos === 'object' ? raw.repos : null;
    } catch {
      cachedRepos = null;
    }
  }
  const s = cachedRepos?.[repo.trim()];
  return (s && s.trim() ? s : 'general').toLowerCase();
}

/** Test-only: clear the rbac cache. */
export function __resetRbacCache(): void {
  cachedRepos = undefined;
}

export interface NotifyInput {
  text: string;
  scope: string;
  resourceType?: string;
  resourceId?: string;
}

/**
 * Emit a `backoffice.notify.google_chat` event via the shared EvtClient. Returns true
 * on success; silently returns false (never throws) when EVT env is unconfigured or
 * the publish fails.
 */
export async function emitNotify(
  input: NotifyInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const baseUrl = (env.EVT_API_URL || '').trim();
  const apiKey = (env.EVT_API_KEY || '').trim();
  const accountId = (env.EVT_ACCOUNT_ID || '').trim();
  if (!baseUrl || !apiKey || !accountId) return false;

  const event = createBackofficeEvent(
    'backoffice.notify.google_chat',
    { userId: (env.PAPERCLIP_AGENT_ID || 'agent').trim(), accountId, role: 'agent' },
    {
      accountId,
      resourceType: input.resourceType || 'notification',
      resourceId: input.resourceId || 'pr-review',
    },
    { text: input.text, scope: input.scope },
    env.NODE_ENV === 'production' ? 'production' : 'staging',
  );

  try {
    await new EvtClient({ baseUrl, apiKey }).publish(event);
    return true;
  } catch {
    return false;
  }
}
