/**
 * PR-review digest: a scheduled job (cron `0 6 * * 1-5` = 8:00 Paris summer / 7:00
 * winter) that lists open PRs awaiting review across the configured repos and posts a
 * Google Chat digest, so reviews don't silently pile up. Emits a
 * `backoffice.notify.google_chat` event → the notify-consumer → the "general" channel.
 *
 * Repos are taken from the baked rbac.json `repos` map (the same source as the
 * per-PR review notification). GitHub is read-only; EVT/GitHub creds come from the
 * worker env (forwarded by the ADAPTER_ENV_PASSTHROUGH patch).
 */
import { readFileSync } from 'node:fs';

const GITHUB_API = 'https://api.github.com';

export interface ReviewPr {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
}

type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

/** Read the `repos` map (owner/repo → scope) from the baked rbac.json; {} on any error. */
export function readRepoScopes(rbacPath: string): Record<string, string> {
  try {
    const raw = JSON.parse(readFileSync(rbacPath, 'utf8')) as { repos?: Record<string, string> };
    return raw.repos && typeof raw.repos === 'object' ? raw.repos : {};
  } catch {
    return {};
  }
}

/** Open, non-draft PRs for a repo ("owner/repo"). Read-only. */
export async function listOpenReviewPrs(
  repo: string,
  token: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<ReviewPr[]> {
  const [owner, name] = repo.split('/');
  if (!owner || !name) throw new Error(`pr-review-digest: bad repo "${repo}" (want owner/repo)`);
  const res = await fetchImpl(`${GITHUB_API}/repos/${owner}/${name}/pulls?state=open&per_page=50`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'gs-pr-review-digest',
    },
  });
  const raw = await res.text();
  if (!res.ok)
    throw new Error(`pr-review-digest: list ${repo} → HTTP ${res.status}: ${raw.slice(0, 200)}`);
  const arr = JSON.parse(raw) as Array<{
    number: number;
    title: string;
    html_url: string;
    draft?: boolean;
    user?: { login?: string };
  }>;
  return arr
    .filter((p) => !p.draft)
    .map((p) => ({
      repo,
      number: p.number,
      title: p.title,
      url: p.html_url,
      author: p.user?.login ?? 'unknown',
    }));
}

/** Render the Google Chat digest text (link syntax `<url|label>`). */
export function buildDigestText(prs: ReviewPr[]): string {
  if (prs.length === 0) return '☀️ Bonjour — aucune PR en attente de revue ce matin.';
  const lines = prs.map((p) => `• <${p.url}|#${p.number}> ${p.title} — ${p.author} (${p.repo})`);
  return `☀️ ${prs.length} PR(s) en attente de revue :\n${lines.join('\n')}`;
}

/** Emit a backoffice.notify.google_chat event (best-effort). Returns true on success. */
export async function emitChatNotify(
  text: string,
  scope: string,
  env: NodeJS.ProcessEnv,
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
    actor: { userId: 'pr-review-digest', accountId, role: 'system' },
    scope: { accountId, resourceType: 'digest', resourceId: 'pr-review' },
    payload: { text, scope },
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

export interface DigestDeps {
  rbacPath: string;
  token: string;
  env: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  logger?: { warn?: (message: string, meta?: Record<string, unknown>) => void };
}

/** Run the digest: gather open PRs across configured repos, post the Chat digest. */
export async function runPrReviewDigest(
  deps: DigestDeps,
): Promise<{ repos: number; prs: number; sent: boolean }> {
  const fetchImpl = deps.fetchImpl ?? (fetch as unknown as FetchLike);
  const repos = Object.keys(readRepoScopes(deps.rbacPath));
  let all: ReviewPr[] = [];
  for (const repo of repos) {
    try {
      all = all.concat(await listOpenReviewPrs(repo, deps.token, fetchImpl));
    } catch (err) {
      deps.logger?.warn?.('pr-review-digest: repo failed', { repo, error: String(err) });
    }
  }
  const sent = await emitChatNotify(buildDigestText(all), 'general', deps.env, fetchImpl);
  return { repos: repos.length, prs: all.length, sent };
}
