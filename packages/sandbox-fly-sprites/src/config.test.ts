import { describe, it, expect, afterEach } from 'vitest';
import { parseDriverConfig, resolveApiKey } from './config.js';

describe('parseDriverConfig', () => {
  it('applies defaults', () => {
    const c = parseDriverConfig({});
    expect(c).toEqual({
      apiKey: null,
      region: 'cdg',
      image: null,
      timeoutMs: 3_600_000,
      reuseLease: true,
    });
  });

  it('honors overrides and trims strings', () => {
    const c = parseDriverConfig({
      apiKey: '  acme/tok  ',
      region: ' fra ',
      image: 'node:22',
      timeoutMs: 120000,
      reuseLease: false,
    });
    expect(c).toEqual({
      apiKey: 'acme/tok',
      region: 'fra',
      image: 'node:22',
      timeoutMs: 120000,
      reuseLease: false,
    });
  });

  it('falls back to defaults for blank/invalid values', () => {
    const c = parseDriverConfig({ region: '  ', image: '', timeoutMs: 'nope' });
    expect(c.region).toBe('cdg');
    expect(c.image).toBeNull();
    expect(c.timeoutMs).toBe(3_600_000);
  });
});

describe('resolveApiKey', () => {
  const base = { region: 'cdg', image: null, timeoutMs: 1000, reuseLease: true };
  afterEach(() => {
    delete process.env.SPRITES_TOKEN;
  });

  it('prefers the config apiKey', () => {
    expect(resolveApiKey({ ...base, apiKey: 'acme/from-config' })).toBe('acme/from-config');
  });

  it('falls back to SPRITES_TOKEN', () => {
    process.env.SPRITES_TOKEN = 'acme/from-env';
    expect(resolveApiKey({ ...base, apiKey: null })).toBe('acme/from-env');
  });

  it('throws when neither is set', () => {
    expect(() => resolveApiKey({ ...base, apiKey: null })).toThrow(/require an API key/);
  });
});
