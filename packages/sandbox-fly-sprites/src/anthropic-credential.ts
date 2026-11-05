import { existsSync, readFileSync } from 'node:fs';

/**
 * The Anthropic credential handed to the in-sandbox Claude run.
 *
 * Workload identity federation (docs/architecture/anthropic-federation.md): the
 * Paperclip container's refresher keeps a short-lived access token for the sandbox
 * service account in a JSON file. When that file exists it is the ONLY accepted source:
 * a stale or unreadable token is an error, never a silent fallback to the long-lived
 * API key — that key must not reach a sandbox where model-generated code runs.
 * When the file does not exist (api_key mode), the legacy key path applies unchanged.
 */
export const DEFAULT_SANDBOX_TOKEN_FILE = '/run/anthropic/sandbox-token';

/** A token must outlive the longest sandbox run (tool RPC timeout: 15 min) plus margin. */
export const MIN_TOKEN_REMAINING_MS = 16 * 60 * 1000;

export type AnthropicCredential =
  | { kind: 'auth_token'; value: string }
  | { kind: 'api_key'; value: string };

export type CredentialResult =
  | { mode: 'federation'; credential?: AnthropicCredential; error?: string }
  | { mode: 'api_key' };

export function readSandboxToken(
  path: string,
  now: number = Date.now(),
  fs: { existsSync(p: string): boolean; readFileSync(p: string, enc: 'utf8'): string } = {
    existsSync,
    readFileSync,
  },
): CredentialResult {
  if (!fs.existsSync(path)) return { mode: 'api_key' };
  try {
    const parsed = JSON.parse(fs.readFileSync(path, 'utf8')) as {
      accessToken?: unknown;
      expiresAt?: unknown;
    };
    if (typeof parsed.accessToken !== 'string' || typeof parsed.expiresAt !== 'number') {
      return { mode: 'federation', error: 'sandbox token file is malformed' };
    }
    const remaining = parsed.expiresAt - now;
    if (remaining < MIN_TOKEN_REMAINING_MS) {
      return {
        mode: 'federation',
        error: `sandbox access token expires in ${Math.max(0, Math.round(remaining / 1000))}s — the anthropic-federation refresher is not renewing it`,
      };
    }
    return { mode: 'federation', credential: { kind: 'auth_token', value: parsed.accessToken } };
  } catch (err) {
    return {
      mode: 'federation',
      error: `sandbox token file unreadable: ${String((err as Error).message ?? err)}`,
    };
  }
}

/** Env for the in-sandbox `claude` process: exactly one Anthropic credential. */
export function claudeEnvFor(
  credential: AnthropicCredential | undefined,
): Record<string, string> | undefined {
  if (!credential) return undefined;
  return credential.kind === 'auth_token'
    ? { ANTHROPIC_AUTH_TOKEN: credential.value }
    : { ANTHROPIC_API_KEY: credential.value };
}
