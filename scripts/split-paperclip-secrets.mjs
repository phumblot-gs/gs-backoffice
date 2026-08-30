#!/usr/bin/env node
/**
 * Copy the secrets Paperclip resolves out of the shared JSON blob and into the
 * individually-stored secrets Terraform creates for them.
 *
 * Paperclip resolves a reference by taking the WHOLE SecretString of one AWS secret;
 * it cannot pull a key out of a JSON document. So the values it needs have to live one
 * per secret. This moves them without a human ever seeing or pasting a credential.
 *
 * Safety properties, in order of importance:
 *   - It never prints a secret value. Not on success, not in an error, not with --dry-run.
 *   - It refuses to overwrite a target that already holds a real value. Re-running is
 *     safe; clobbering a rotated credential is not. Use --force to override deliberately.
 *   - It reads and writes through the AWS CLI, so it uses whatever credentials you are
 *     already authenticated with — nothing is stored or configured here.
 *
 *   node scripts/split-paperclip-secrets.mjs [--dry-run] [--force]
 *     [--env staging] [--region eu-west-1]
 */
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const ENV = opt('env', 'staging');
const REGION = opt('region', 'eu-west-1');
const PROJECT = 'gs-backoffice';
const DRY_RUN = flag('dry-run');
const FORCE = flag('force');
const PLACEHOLDER = 'CHANGE_ME';

/** JSON key in the shared blob → short name of the individual secret. */
const MAPPING = {
  SPRITES_TOKEN: 'sprites-token',
  ANTHROPIC_API_KEY: 'anthropic-api-key',
  GITHUB_APP_PRIVATE_KEY: 'github-app-private-key',
  EVT_API_KEY: 'evt-api-key',
  PAPERCLIP_API_KEY: 'paperclip-api-key',
};

const aws = (...argv) =>
  execFileSync('aws', [...argv, '--region', REGION], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });

/** Read a secret's value. Returns null when the secret does not exist. */
function readSecret(secretId) {
  try {
    return aws(
      'secretsmanager',
      'get-secret-value',
      '--secret-id',
      secretId,
      '--query',
      'SecretString',
      '--output',
      'text',
    );
  } catch {
    return null;
  }
}

const sourceId = `${PROJECT}/${ENV}/app`;
const source = readSecret(sourceId);
if (source === null) {
  console.error(`Cannot read ${sourceId}. Check your AWS credentials and --env.`);
  process.exit(2);
}

let blob;
try {
  blob = JSON.parse(source);
} catch {
  console.error(`${sourceId} is not JSON — nothing to split.`);
  process.exit(2);
}

let copied = 0;
let skipped = 0;
let missing = 0;

for (const [key, shortName] of Object.entries(MAPPING)) {
  const targetId = `${PROJECT}/${ENV}/paperclip/${shortName}`;
  const value = blob[key];

  if (typeof value !== 'string' || !value.trim() || value === PLACEHOLDER) {
    console.log(`· ${key.padEnd(24)} absent or unset in the blob — skipped`);
    missing += 1;
    continue;
  }

  const current = readSecret(targetId);
  if (current === null) {
    console.error(
      `✗ ${key.padEnd(24)} target ${targetId} does not exist — apply the Terraform first`,
    );
    process.exitCode = 1;
    continue;
  }
  if (current !== PLACEHOLDER && !FORCE) {
    console.log(`· ${key.padEnd(24)} target already set — skipped (use --force to overwrite)`);
    skipped += 1;
    continue;
  }

  if (DRY_RUN) {
    console.log(`→ ${key.padEnd(24)} would be written to ${targetId}`);
    copied += 1;
    continue;
  }

  // The value goes through argv here. That is visible to a local `ps` for the duration
  // of the call — acceptable on an operator's own machine, and the alternative
  // (a temp file) leaves it on disk, which is worse.
  aws('secretsmanager', 'put-secret-value', '--secret-id', targetId, '--secret-string', value);
  console.log(`✓ ${key.padEnd(24)} → ${targetId}`);
  copied += 1;
}

console.log(
  `\n${DRY_RUN ? 'Would copy' : 'Copied'} ${copied}, skipped ${skipped}, absent ${missing}.` +
    (DRY_RUN ? '\nRe-run without --dry-run to apply.' : ''),
);
