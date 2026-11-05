import { chmodSync, renameSync, writeFileSync } from 'node:fs';

/**
 * Keyless Anthropic authentication for the Paperclip container (Workload Identity
 * Federation, docs/architecture/anthropic-federation.md).
 *
 * Two outputs, refreshed in the background:
 *
 *  1. AGENTS — an AWS STS web identity token (JWT, `sub` = the Paperclip task role ARN)
 *     written to ANTHROPIC_IDENTITY_TOKEN_FILE. Claude Code (claude_local agents) reads
 *     it and performs the federation exchange itself. The agents' federation rule has
 *     `check_jti` disabled (decided 2026-11-06): several concurrent `claude` processes
 *     read the same file, and each would otherwise be the second presenter of its jti.
 *
 *  2. SANDBOX — a short-lived Anthropic access token minted HERE (one exchange point,
 *     its own service account and rule, `check_jti` kept on: every exchange uses a fresh
 *     JWT), written as JSON to the sandbox token file. The Fly Sprites plugin hands it to
 *     the in-sandbox Claude run as ANTHROPIC_AUTH_TOKEN, so the long-lived API key never
 *     enters a sandbox where model-generated code runs.
 *
 * Never logs a token. Failures are logged with the BACKOFFICE_JOB_FAILURE marker so
 * the existing CloudWatch alarm fires (a dead refresher stops every agent within
 * minutes, when the last written JWT expires).
 */

export const JOB_FAILURE_MARKER = 'BACKOFFICE_JOB_FAILURE';
export const TOKEN_ENDPOINT = 'https://api.anthropic.com/v1/oauth/token';
export const JWT_BEARER_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer';

export interface FederationConfig {
  /** Audience of the JWT read by Claude Code — must match the agents rule. */
  agentsAudience: string;
  identityTokenFile: string;
  /** STS token lifetime (60–3600 s). Short on purpose: the file is re-read per exchange. */
  identityTokenSeconds: number;
  sandbox?: {
    audience: string;
    ruleId: string;
    organizationId: string;
    serviceAccountId: string;
    workspaceId?: string;
    tokenFile: string;
    /** Re-mint when the current access token has less than this left. */
    minRemainingSeconds: number;
  };
}

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export interface Deps {
  /** STS GetWebIdentityToken for the given audience (regional endpoint). */
  getIdentityToken(audience: string, durationSeconds: number): Promise<string>;
  fetch: typeof fetch;
  now(): number;
  writeSecretFile(path: string, content: string): void;
  logger: Logger;
}

export interface SandboxToken {
  accessToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export interface ExchangeParams {
  assertion: string;
  ruleId: string;
  organizationId: string;
  serviceAccountId: string;
  workspaceId?: string;
}

/** Exchange an identity JWT for an Anthropic access token (RFC 6749 response). */
export async function exchangeIdentityToken(
  deps: Pick<Deps, 'fetch' | 'now'>,
  p: ExchangeParams,
): Promise<SandboxToken> {
  const res = await deps.fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: JWT_BEARER_GRANT,
      assertion: p.assertion,
      federation_rule_id: p.ruleId,
      organization_id: p.organizationId,
      service_account_id: p.serviceAccountId,
      ...(p.workspaceId ? { workspace_id: p.workspaceId } : {}),
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    // The error body names a reason (e.g. match_subject_prefix, jti_reused); it never
    // echoes the assertion, but keep it short anyway.
    throw new Error(`token exchange failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  const body = JSON.parse(text) as { access_token?: unknown; expires_in?: unknown };
  if (typeof body.access_token !== 'string' || typeof body.expires_in !== 'number') {
    throw new Error('token exchange returned no access_token / expires_in');
  }
  return { accessToken: body.access_token, expiresAt: deps.now() + body.expires_in * 1000 };
}

/** Write a credential file atomically with owner-only permissions. */
export function writeSecretFileAtomic(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export class Refresher {
  private sandboxToken: SandboxToken | undefined;

  constructor(
    private readonly cfg: FederationConfig,
    private readonly deps: Deps,
  ) {}

  /** One refresh pass. Returns false when anything failed (already logged). */
  async tick(): Promise<boolean> {
    let ok = true;
    try {
      const jwt = await this.deps.getIdentityToken(
        this.cfg.agentsAudience,
        this.cfg.identityTokenSeconds,
      );
      this.deps.writeSecretFile(this.cfg.identityTokenFile, jwt);
    } catch (err) {
      ok = false;
      this.deps.logger.error(
        `${JOB_FAILURE_MARKER} anthropic-federation: identity token refresh failed`,
        {
          error: String((err as Error).message ?? err).slice(0, 300),
        },
      );
    }

    const sb = this.cfg.sandbox;
    if (sb) {
      const remaining = this.sandboxToken ? this.sandboxToken.expiresAt - this.deps.now() : -1;
      if (remaining < sb.minRemainingSeconds * 1000) {
        try {
          // A FRESH JWT per exchange: the sandbox rule keeps jti replay protection on.
          const assertion = await this.deps.getIdentityToken(sb.audience, 300);
          const token = await exchangeIdentityToken(this.deps, {
            assertion,
            ruleId: sb.ruleId,
            organizationId: sb.organizationId,
            serviceAccountId: sb.serviceAccountId,
            workspaceId: sb.workspaceId,
          });
          this.deps.writeSecretFile(sb.tokenFile, JSON.stringify(token));
          this.sandboxToken = token;
          this.deps.logger.info('anthropic-federation: sandbox access token minted', {
            expiresAt: new Date(token.expiresAt).toISOString(),
          });
        } catch (err) {
          ok = false;
          this.deps.logger.error(
            `${JOB_FAILURE_MARKER} anthropic-federation: sandbox token mint failed`,
            {
              error: String((err as Error).message ?? err).slice(0, 300),
            },
          );
        }
      }
    }
    return ok;
  }
}

/** Read the federation config from the environment. Throws on a partial config. */
export function configFromEnv(env: NodeJS.ProcessEnv): FederationConfig {
  const req = (k: string): string => {
    const v = (env[k] ?? '').trim();
    if (!v) throw new Error(`${k} is required for GS_ANTHROPIC_AUTH=federation`);
    return v;
  };
  const cfg: FederationConfig = {
    agentsAudience: req('GS_ANTHROPIC_AGENTS_AUDIENCE'),
    identityTokenFile: req('ANTHROPIC_IDENTITY_TOKEN_FILE'),
    identityTokenSeconds: 300,
  };
  if ((env.GS_ANTHROPIC_SANDBOX_RULE_ID ?? '').trim()) {
    cfg.sandbox = {
      audience: req('GS_ANTHROPIC_SANDBOX_AUDIENCE'),
      ruleId: req('GS_ANTHROPIC_SANDBOX_RULE_ID'),
      organizationId: req('ANTHROPIC_ORGANIZATION_ID'),
      serviceAccountId: req('GS_ANTHROPIC_SANDBOX_SERVICE_ACCOUNT_ID'),
      workspaceId: (env.ANTHROPIC_WORKSPACE_ID ?? '').trim() || undefined,
      tokenFile: req('GS_ANTHROPIC_SANDBOX_TOKEN_FILE'),
      minRemainingSeconds: 20 * 60,
    };
  }
  return cfg;
}
