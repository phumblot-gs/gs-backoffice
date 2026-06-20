/** Resolved driver configuration for a Fly Sprites environment. */
export interface SpriteDriverConfig {
  apiKey: string | null;
  region: string;
  image: string | null;
  timeoutMs: number;
  reuseLease: boolean;
}

const DEFAULT_TIMEOUT_MS = 3_600_000;
const DEFAULT_REGION = 'cdg';

/** Parse + normalize the raw driver config (mirrors the manifest configSchema). */
export function parseDriverConfig(raw: Record<string, unknown>): SpriteDriverConfig {
  const region =
    typeof raw.region === 'string' && raw.region.trim().length > 0
      ? raw.region.trim()
      : DEFAULT_REGION;
  const timeoutMs = Number(raw.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  return {
    apiKey:
      typeof raw.apiKey === 'string' && raw.apiKey.trim().length > 0 ? raw.apiKey.trim() : null,
    region,
    image: typeof raw.image === 'string' && raw.image.trim().length > 0 ? raw.image.trim() : null,
    timeoutMs: Number.isFinite(timeoutMs) ? Math.trunc(timeoutMs) : DEFAULT_TIMEOUT_MS,
    reuseLease: raw.reuseLease !== false, // default true
  };
}

/** Resolve the Sprites API token from config or the SPRITES_TOKEN env fallback. */
export function resolveApiKey(config: SpriteDriverConfig): string {
  if (config.apiKey) return config.apiKey;
  const env = process.env.SPRITES_TOKEN?.trim() ?? '';
  if (!env) {
    throw new Error('Fly Sprites environments require an API key in config or SPRITES_TOKEN.');
  }
  return env;
}
