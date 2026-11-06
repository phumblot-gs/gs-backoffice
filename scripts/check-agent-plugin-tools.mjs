#!/usr/bin/env node
/**
 * Manual, READ-ONLY check of the plugin tools each agent may call through the Paperclip
 * tool gateway, against `pluginTools` in config/agents-authz.json.
 *
 * Why manual: tool access profiles are not readable by plugins in Paperclip 2026.824.1,
 * so the drift job reports `pluginTools` as `unverifiable`. This script reads them over
 * the board API instead. It is baked into the Paperclip image and runs INSIDE the
 * container (ECS Exec), on loopback, with the container's own Paperclip key:
 *
 *   node /opt/gs-agent-tools/check-agent-plugin-tools.mjs staging
 *
 * GET requests only. Prints tool names and agent slugs, never a credential.
 * Exit code: 0 = matches, 1 = drift, 2 = could not check.
 */
import { readFileSync } from 'node:fs';

const env = process.argv[2];
const configPath = process.argv[3] ?? '/opt/gs-agent-tools/agents-authz.json';
const base = (process.env.PAPERCLIP_CHECK_URL ?? 'http://localhost:3100').replace(/\/$/, '');
const key = process.env.PAPERCLIP_API_KEY;
const company = process.env.PAPERCLIP_COMPANY_ID;

function fail(msg) {
  console.error(`check-agent-plugin-tools: ${msg}`);
  process.exit(2);
}

if (env !== 'staging' && env !== 'production') fail('usage: <staging|production> [config path]');
if (!key || !company) fail('PAPERCLIP_API_KEY and PAPERCLIP_COMPANY_ID are required');

const config = JSON.parse(readFileSync(configPath, 'utf8'));
const section = config.environments?.[env];
if (!section) fail(`no environments.${env} in ${configPath}`);

async function get(path) {
  const res = await fetch(`${base}${path}`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${key}` },
  });
  if (!res.ok) fail(`GET ${path.replace(company, '<company>')} → HTTP ${res.status}`);
  return res.json();
}

let drift = false;
const report = [];

// Tool policies are evaluated BEFORE profiles by the gateway: any policy can widen access.
const policies = await get(`/api/companies/${company}/tools/policies`);
const policyList = Array.isArray(policies) ? policies : (policies.policies ?? []);
if (policyList.length > 0) {
  drift = true;
  report.push({
    scope: 'company',
    status: 'drift',
    reason: `${policyList.length} tool policy(ies) exist; agents-authz declares none — review them`,
    policyIds: policyList.map((p) => p.id),
  });
}

for (const [slug, agent] of Object.entries(config.agents)) {
  const id = section.agentIds?.[slug];
  const override = section.overrides?.[slug] ?? {};
  const want = [...(override.pluginTools ?? agent.pluginTools ?? [])].sort();
  if (!id) {
    report.push({ agent: slug, status: 'skipped', reason: `no ${env} agent id` });
    continue;
  }
  const eff = await get(`/api/companies/${company}/tools/profiles/effective/agents/${id}`);
  const have = [...new Set(eff.allowedToolNames ?? [])].sort();
  const extra = have.filter((t) => !want.includes(t));
  const missing = want.filter((t) => !have.includes(t));
  const profiles = (eff.profiles ?? []).map((p) => `${p.profileKey}(${p.defaultAction})`);
  if (extra.length || missing.length) {
    drift = true;
    report.push({ agent: slug, status: 'drift', extra, missing, profiles });
  } else {
    report.push({ agent: slug, status: 'ok', tools: have, profiles });
  }
}

console.log(JSON.stringify({ environment: env, drift, report }, null, 2));
process.exit(drift ? 1 : 0);
