/**
 * GitHub App identity for the self-evolution bridge (B2).
 *
 * The bridge opens PRs (and reads diffs) with a short-lived **installation token**
 * minted from the "GRAFMAKER Henri" GitHub App, so PRs are authored by the bot
 * (`grafmaker-henri[bot]`) — distinct from the human who approves/merges them
 * (SOC 2 CC8, separation of duties). The App credentials live in the container env
 * (GITHUB_APP_ID / GITHUB_APP_INSTALLATION_ID / GITHUB_APP_PRIVATE_KEY); when they are
 * absent or still the `CHANGE_ME` placeholder, the bridge falls back to the PATs, so
 * rollout is safe and reversible.
 *
 * No external dependency: the App JWT is signed with `node:crypto` (RS256).
 */
import { createSign } from 'node:crypto';

type FetchLike = (
  url: string,
  init: RequestInit,
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

/** Read an env value, treating empty and the Terraform `CHANGE_ME` seed as absent. */
function envVal(env: NodeJS.ProcessEnv, key: string): string {
  const v = (env[key] ?? '').trim();
  return v === 'CHANGE_ME' ? '' : v;
}

/** True iff a usable GitHub App credential set is present in the env. */
export function hasGitHubApp(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    envVal(env, 'GITHUB_APP_ID') &&
    envVal(env, 'GITHUB_APP_INSTALLATION_ID') &&
    envVal(env, 'GITHUB_APP_PRIVATE_KEY'),
  );
}

function readAppEnv(env: NodeJS.ProcessEnv): {
  appId: string;
  installationId: string;
  privateKey: string;
} {
  let privateKey = envVal(env, 'GITHUB_APP_PRIVATE_KEY');
  // Tolerate a PEM stored with literal "\n" escapes (some secret stores do this).
  if (privateKey.includes('\\n') && !privateKey.includes('\n')) {
    privateKey = privateKey.replace(/\\n/g, '\n');
  }
  return {
    appId: envVal(env, 'GITHUB_APP_ID'),
    installationId: envVal(env, 'GITHUB_APP_INSTALLATION_ID'),
    privateKey,
  };
}

const b64url = (input: string | Buffer): string => Buffer.from(input).toString('base64url');

/**
 * Build a short-lived App JWT (RS256), used once to exchange for an installation token.
 * `nowSec` is injectable for tests. `iat` is backdated 60s for clock skew; `exp` is +9min
 * (GitHub caps App JWTs at 10 minutes).
 */
export function buildAppJwt(
  appId: string,
  privateKey: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iat: nowSec - 60, exp: nowSec + 540, iss: appId }));
  const signingInput = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${signer.sign(privateKey).toString('base64url')}`;
}

// Installation tokens are valid ~1h; cache in-process and refresh ~5min before expiry.
let cache: { token: string; expMs: number } | null = null;

/** Test-only: clear the cached installation token. */
export function __resetTokenCache(): void {
  cache = null;
}

/**
 * Mint (or return a cached) GitHub App installation token by signing an App JWT and
 * exchanging it at `POST /app/installations/{id}/access_tokens`. Throws on misconfig or
 * a failed exchange (the caller decides whether to surface or fall back).
 */
export async function mintInstallationToken(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<string> {
  const now = Date.now();
  if (cache && cache.expMs - now > 5 * 60 * 1000) return cache.token;

  const { appId, installationId, privateKey } = readAppEnv(env);
  if (!appId || !installationId || !privateKey) {
    throw new Error(
      'agent-sandbox-mcp: GitHub App env incomplete (need GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, GITHUB_APP_PRIVATE_KEY).',
    );
  }
  const jwt = buildAppJwt(appId, privateKey);
  const url = `https://api.github.com/app/installations/${installationId}/access_tokens`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'gs-agent-sandbox-mcp',
    },
  });
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(
      `agent-sandbox-mcp: GitHub App token exchange → HTTP ${res.status}: ${raw.slice(0, 300)}`,
    );
  }
  const j = JSON.parse(raw) as { token?: string; expires_at?: string };
  if (!j.token) throw new Error('agent-sandbox-mcp: GitHub App token exchange returned no token.');
  cache = { token: j.token, expMs: j.expires_at ? Date.parse(j.expires_at) : now + 3_600_000 };
  return cache.token;
}

/**
 * The GitHub token to use: a GitHub App installation token when the App is configured,
 * else the PAT supplied by `patFallback`. The App token carries the App's installation
 * permissions (contents + PRs), so it serves both read and push paths.
 */
export async function resolveGitHubToken(opts: {
  patFallback: () => string;
  env?: NodeJS.ProcessEnv;
  mintFetch?: FetchLike;
}): Promise<string> {
  const env = opts.env ?? process.env;
  if (hasGitHubApp(env)) return mintInstallationToken(env, opts.mintFetch);
  return opts.patFallback();
}
