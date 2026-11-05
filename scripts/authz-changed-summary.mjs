#!/usr/bin/env node
/**
 * Summarise a change to config/agents-authz.json between two git revisions, for the
 * backoffice.authz.changed audit event. Prints ONE JSON object on stdout:
 *   { changedAgents: [slug…], environments: ["staging"|"production"…], changedSections: [...] }
 * No secrets can be involved: the file holds none (CI enforces it).
 *
 * Usage: node scripts/authz-changed-summary.mjs <baseRev> <headRev>
 */
import { execFileSync } from 'node:child_process';

const [base, head] = process.argv.slice(2);
const PATH = 'config/agents-authz.json';
const read = (rev) => {
  try {
    return JSON.parse(
      execFileSync('git', ['show', `${rev}:${PATH}`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    );
  } catch {
    return null; // file absent at that revision (first introduction)
  }
};
const canon = (v) =>
  Array.isArray(v)
    ? `[${v.map(canon).join(',')}]`
    : v && typeof v === 'object'
      ? `{${Object.keys(v)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canon(v[k])}`)
          .join(',')}}`
      : JSON.stringify(v ?? null);
const differs = (a, b) => canon(a) !== canon(b);

const before = read(base) ?? {};
const after = read(head) ?? {};
const ENVS = ['staging', 'production'];
const changedSections = ['version', 'company', 'instance', 'profiles'].filter((k) =>
  differs(before[k], after[k]),
);
const agents = new Set();
const environments = new Set();

for (const slug of new Set([
  ...Object.keys(before.agents ?? {}),
  ...Object.keys(after.agents ?? {}),
])) {
  if (differs(before.agents?.[slug], after.agents?.[slug])) {
    agents.add(slug);
    ENVS.forEach((e) => environments.add(e)); // common definition → both environments
  }
}
for (const env of ENVS) {
  const b = before.environments?.[env] ?? {};
  const a = after.environments?.[env] ?? {};
  if (differs(b.companyId, a.companyId)) environments.add(env);
  for (const key of ['agentIds', 'overrides']) {
    for (const slug of new Set([...Object.keys(b[key] ?? {}), ...Object.keys(a[key] ?? {})])) {
      if (differs(b[key]?.[slug], a[key]?.[slug])) {
        agents.add(slug);
        environments.add(env);
      }
    }
  }
}
if (changedSections.length > 0) ENVS.forEach((e) => environments.add(e));

process.stdout.write(
  JSON.stringify({
    changedAgents: [...agents].sort(),
    environments: ENVS.filter((e) => environments.has(e)),
    changedSections,
  }),
);
