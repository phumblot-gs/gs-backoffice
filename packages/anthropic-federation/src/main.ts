import { GetWebIdentityTokenCommand, STSClient } from '@aws-sdk/client-sts';
import {
  configFromEnv,
  JOB_FAILURE_MARKER,
  Refresher,
  writeSecretFileAtomic,
} from './refresher.js';

/**
 * Entry point baked at /opt/gs-agent-tools/anthropic-federation/refresher.mjs.
 *   node refresher.mjs --once   → one pass (entrypoint, before Paperclip starts)
 *   node refresher.mjs          → loop every REFRESH_SECONDS (supervised by the entrypoint)
 * Credentials: the ECS task role, via the default AWS chain. GetWebIdentityToken is not
 * served by the STS global endpoint, so the client is pinned to the regional one.
 */
const REFRESH_SECONDS = 180;

const log = (level: 'info' | 'error') => (msg: string, meta?: Record<string, unknown>) =>
  (level === 'error' ? console.error : console.info)(
    JSON.stringify({
      level,
      time: new Date().toISOString(),
      name: 'anthropic-federation',
      msg,
      ...meta,
    }),
  );
const logger = { info: log('info'), error: log('error') };

async function main(): Promise<void> {
  const region = (process.env.AWS_REGION ?? '').trim();
  if (!region) throw new Error('AWS_REGION is required');
  const cfg = configFromEnv(process.env);
  const sts = new STSClient({ region, useGlobalEndpoint: false });
  const refresher = new Refresher(cfg, {
    getIdentityToken: async (audience, durationSeconds) => {
      const out = await sts.send(
        new GetWebIdentityTokenCommand({
          Audience: [audience],
          SigningAlgorithm: 'RS256',
          DurationSeconds: durationSeconds,
        }),
      );
      if (!out.WebIdentityToken) throw new Error('STS returned no WebIdentityToken');
      return out.WebIdentityToken;
    },
    fetch,
    now: () => Date.now(),
    writeSecretFile: writeSecretFileAtomic,
    logger,
  });

  if (process.argv.includes('--once')) {
    const ok = await refresher.tick();
    logger.info('anthropic-federation: initial refresh done', { ok });
    process.exit(ok ? 0 : 1);
  }
  for (;;) {
    await refresher.tick();
    await new Promise((r) => setTimeout(r, REFRESH_SECONDS * 1000));
  }
}

main().catch((err) => {
  logger.error(`${JOB_FAILURE_MARKER} anthropic-federation: refresher crashed`, {
    error: String((err as Error).message ?? err).slice(0, 300),
  });
  process.exit(1);
});
