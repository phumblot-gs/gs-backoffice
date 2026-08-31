/**
 * PR-review digest: a scheduled job (cron `0 6 * * 1-5` = 8:00 Paris summer / 7:00
 * winter) that lists open PRs awaiting review across the configured repos and posts a
 * Google Chat digest, so reviews don't silently pile up. Emits a
 * `backoffice.notify.google_chat` event → the notify-consumer → the "general" channel.
 *
 * Repos are taken from the baked rbac.json `repos` map (the same source as the
 * per-PR review notification). GitHub is read-only.
 *
 * Credentials are passed in ALREADY RESOLVED, never read from the environment here.
 * That is what lets the caller source them from Paperclip's secret store instead of
 * the ADAPTER_ENV_PASSTHROUGH patch: this module no longer cares where they came
 * from, so retiring the patch is a change at one call site rather than in here.
 */
import { readFileSync } from 'node:fs';
import { EvtClient } from '@gs-backoffice/evt-client';
import { createBackofficeEvent } from '@gs-backoffice/core';

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

/** A repo the digest could not query, with a short chat-safe reason. */
export interface RepoFailure {
  repo: string;
  error: string;
}

/** Collapse an error into a single short line safe to embed in a Chat message. */
export function summarizeError(err: unknown): string {
  const oneLine = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim();
  return oneLine.length > 160 ? `${oneLine.slice(0, 157)}...` : oneLine;
}

/**
 * Render the Google Chat digest text (link syntax `<url|label>`).
 *
 * A repo we failed to query must never be reported as "nothing to review": when
 * anything went wrong the message states the review status is UNKNOWN and lists
 * what failed. The reassuring all-clear is only ever sent when every configured
 * repo actually answered.
 */
export function buildDigestText(prs: ReviewPr[], failures: RepoFailure[] = []): string {
  const lines = prs.map((p) => `• <${p.url}|#${p.number}> ${p.title} — ${p.author} (${p.repo})`);
  if (failures.length === 0) {
    if (prs.length === 0) return '☀️ Bonjour — aucune PR en attente de revue ce matin.';
    return `☀️ ${prs.length} PR(s) en attente de revue :\n${lines.join('\n')}`;
  }
  const header =
    prs.length === 0
      ? "🚨 Digest PR indisponible : impossible d'établir la liste des PR en attente. Le statut des revues est INCONNU — ce n'est pas un « rien à revoir »."
      : `⚠️ Digest PR incomplet : ${prs.length} PR(s) listée(s), mais ${failures.length} source(s) injoignable(s). La liste ci-dessous peut être incomplète.`;
  const body = prs.length === 0 ? '' : `\n${lines.join('\n')}`;
  const failLines = failures.map((f) => `• ${f.repo} — ${f.error}`);
  return `${header}${body}\n\nÉchecs :\n${failLines.join('\n')}`;
}

/**
 * What publishing an EVT event needs, resolved. `apiKey` is the only secret; the
 * other three are configuration and legitimately stay in the environment.
 */
export interface EvtCredentials {
  baseUrl: string;
  apiKey: string;
  accountId: string;
  environment: 'production' | 'staging';
}

/**
 * Build EVT credentials from the non-secret configuration in the environment plus a
 * separately-sourced API key.
 *
 * The split is deliberate. `EVT_API_URL`, `EVT_ACCOUNT_ID` and `NODE_ENV` are
 * configuration and stay in the environment; only the key is a secret, and it arrives
 * from wherever the caller resolved it — Paperclip's store or, until the migration
 * completes, `EVT_API_KEY`.
 *
 * Reading the key from the same env blob as the config would quietly couple the two:
 * removing `EVT_API_KEY` from the container would then also lose a perfectly good
 * resolved key, and the digest would go silent for a reason nothing in the code
 * suggests. That is the whole failure this refactor exists to prevent, so the seam is
 * placed where the removal will actually happen.
 *
 * Returns undefined when anything required is missing, so a caller cannot mistake an
 * unconfigured EVT for a working one.
 */
export function evtCredentialsFromEnv(
  env: NodeJS.ProcessEnv,
  apiKeyOverride?: string,
): EvtCredentials | undefined {
  const baseUrl = (env.EVT_API_URL || '').trim();
  const apiKey = (apiKeyOverride || env.EVT_API_KEY || '').trim();
  const accountId = (env.EVT_ACCOUNT_ID || '').trim();
  if (!baseUrl || !apiKey || !accountId) return undefined;
  return {
    baseUrl,
    apiKey,
    accountId,
    environment: env.NODE_ENV === 'production' ? 'production' : 'staging',
  };
}

/**
 * Emit a backoffice.notify.google_chat event via the shared EvtClient (best-effort).
 * Returns true on success; never throws.
 */
export async function emitChatNotify(
  text: string,
  scope: string,
  evt: EvtCredentials | undefined,
): Promise<boolean> {
  if (!evt) return false;
  const { baseUrl, apiKey, accountId } = evt;
  if (!baseUrl || !apiKey || !accountId) return false;
  const event = createBackofficeEvent(
    'backoffice.notify.google_chat',
    { userId: 'pr-review-digest', accountId, role: 'system' },
    { accountId, resourceType: 'digest', resourceId: 'pr-review' },
    { text, scope },
    evt.environment,
  );
  try {
    await new EvtClient({ baseUrl, apiKey }).publish(event);
    return true;
  } catch {
    return false;
  }
}

export interface DigestDeps {
  rbacPath: string;
  token: string;
  /** Resolved EVT credentials. Undefined means "not configured" — the digest still
   *  runs and reports, it just cannot publish, and says so via `sent: false`. */
  evt: EvtCredentials | undefined;
  fetchImpl?: FetchLike;
  logger?: { warn?: (message: string, meta?: Record<string, unknown>) => void };
}

/**
 * Run the digest: gather open PRs across configured repos, post the Chat digest.
 *
 * Every way this can go wrong — an unreadable rbac.json, a repo GitHub refuses —
 * ends up in `failed` and in the posted message. The caller is expected to log a
 * `JOB_FAILURE_MARKER` line when `failed` is non-empty (see tools.ts).
 */
export async function runPrReviewDigest(
  deps: DigestDeps,
): Promise<{ repos: number; prs: number; sent: boolean; failed: RepoFailure[] }> {
  const fetchImpl = deps.fetchImpl ?? (fetch as unknown as FetchLike);
  const repos = Object.keys(readRepoScopes(deps.rbacPath));
  const all: ReviewPr[] = [];
  const failed: RepoFailure[] = [];
  // No repo at all means the config never loaded — a silent all-clear would be a lie.
  if (repos.length === 0) {
    failed.push({
      repo: '(configuration)',
      error: `aucun dépôt configuré — rbac.json illisible ou vide (${deps.rbacPath})`,
    });
  }
  for (const repo of repos) {
    try {
      all.push(...(await listOpenReviewPrs(repo, deps.token, fetchImpl)));
    } catch (err) {
      const error = summarizeError(err);
      failed.push({ repo, error });
      deps.logger?.warn?.('pr-review-digest: repo failed', { repo, error });
    }
  }
  const sent = await emitChatNotify(buildDigestText(all, failed), 'general', deps.evt);
  return { repos: repos.length, prs: all.length, sent, failed };
}
