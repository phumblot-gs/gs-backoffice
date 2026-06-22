/**
 * Best-effort EVT emission from the bridge. Used to notify (via the notify-consumer
 * → Google Chat) when a PR needs human review — the Gate-3 step. The notify-consumer
 * already handles `backoffice.notify.google_chat` (payload `{text, scope}`) and routes
 * the scope to its Chat channel, falling back to "general".
 *
 * The notify SCOPE per repo is configured in config/rbac.json (`repos: {owner/repo →
 * scope}`), baked into the image at /opt/gs-agent-tools/rbac.json (synced with RBAC at
 * deploy). Emission is best-effort: a notify failure must never fail the tool call.
 */
import { readFileSync } from 'node:fs';

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

type FetchLike = (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number }>;

/**
 * Emit a `backoffice.notify.google_chat` event to EVT. Returns true on success.
 * Silently no-ops (returns false) if EVT env is not configured, and never throws.
 */
export async function emitNotify(
  input: NotifyInput,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<boolean> {
  const url = (env.EVT_API_URL || '').trim().replace(/\/+$/, '');
  const key = (env.EVT_API_KEY || '').trim();
  const accountId = (env.EVT_ACCOUNT_ID || '').trim();
  if (!url || !key || !accountId) return false;

  const event = {
    eventType: 'backoffice.notify.google_chat',
    source: {
      application: 'gs-backoffice',
      version: '0.1.0',
      environment: env.NODE_ENV === 'production' ? 'production' : 'staging',
    },
    actor: { userId: (env.PAPERCLIP_AGENT_ID || 'agent').trim(), accountId, role: 'agent' },
    scope: {
      accountId,
      resourceType: input.resourceType || 'notification',
      resourceId: input.resourceId || 'pr-review',
    },
    payload: { text: input.text, scope: input.scope },
  };

  try {
    const res = await fetchImpl(`${url}/v1/events`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    });
    return res.ok;
  } catch {
    return false;
  }
}
