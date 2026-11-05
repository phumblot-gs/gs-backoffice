import { describe, expect, it } from 'vitest';
import { claudeEnvFor, MIN_TOKEN_REMAINING_MS, readSandboxToken } from './anthropic-credential.js';

const fsWith = (content: string | null) => ({
  existsSync: () => content !== null,
  readFileSync: () => {
    if (content === null) throw new Error('ENOENT');
    return content;
  },
});

describe('readSandboxToken', () => {
  it('falls back to the legacy key path only when no token file exists', () => {
    expect(readSandboxToken('/x', 0, fsWith(null))).toEqual({ mode: 'api_key' });
  });

  it('returns the access token when it has enough lifetime left', () => {
    const r = readSandboxToken(
      '/x',
      0,
      fsWith(JSON.stringify({ accessToken: 'sk-ant-oat01-x', expiresAt: 30 * 60 * 1000 })),
    );
    expect(r).toEqual({
      mode: 'federation',
      credential: { kind: 'auth_token', value: 'sk-ant-oat01-x' },
    });
  });

  it('refuses a token about to expire — no fallback to the key', () => {
    const r = readSandboxToken(
      '/x',
      0,
      fsWith(JSON.stringify({ accessToken: 't', expiresAt: MIN_TOKEN_REMAINING_MS - 1 })),
    );
    expect(r.mode).toBe('federation');
    expect('credential' in r && r.credential).toBeFalsy();
    expect('error' in r && r.error).toMatch(/not renewing/);
  });

  it('refuses a malformed file', () => {
    expect(readSandboxToken('/x', 0, fsWith('{"accessToken":1}'))).toEqual({
      mode: 'federation',
      error: 'sandbox token file is malformed',
    });
  });
});

describe('claudeEnvFor', () => {
  it('sets exactly one credential variable', () => {
    expect(claudeEnvFor({ kind: 'auth_token', value: 't' })).toEqual({ ANTHROPIC_AUTH_TOKEN: 't' });
    expect(claudeEnvFor({ kind: 'api_key', value: 'k' })).toEqual({ ANTHROPIC_API_KEY: 'k' });
    expect(claudeEnvFor(undefined)).toBeUndefined();
  });
});
