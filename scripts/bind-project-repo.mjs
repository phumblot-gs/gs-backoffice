#!/usr/bin/env node
/**
 * Bind the gs-backoffice git repo to its Paperclip project's PRIMARY WORKSPACE, so the
 * self-evolution bridge can resolve `repoUrl` (and the engineer) from project context
 * instead of the Methods Officer having to supply them (the GRA-42 blocker). This is the
 * runtime half of B1; the code half (bridge resolution) ships in the repo.
 *
 * ISOLATION: setting a workspace repoUrl is a pure DB insert — it does NOT clone on the
 * Paperclip host. A host checkout happens ONLY if `executionWorkspacePolicy` is enabled
 * with `workspaceStrategy.type === "git_worktree"` (verified in Paperclip v2026.609.0).
 * This script never touches that policy; it asserts it is not git_worktree and reports it.
 *
 * SAFE BY DEFAULT: read-only inspection unless `APPLY=1`. Run it once to see the real
 * state + the isolation verdict, then re-run with APPLY=1 to bind. Idempotent: if the
 * project's codebase repoUrl already matches, it does nothing.
 *
 *   PAPERCLIP_API_URL=…  PAPERCLIP_API_KEY=…  PAPERCLIP_COMPANY_ID=… \
 *     [PROJECT_ID=…] [REPO_URL=…] [DEFAULT_REF=main] [APPLY=1] \
 *     node scripts/bind-project-repo.mjs
 *
 * PROJECT_ID defaults to the project named "gs-backoffice". REPO_URL defaults to the
 * gs-backoffice repo (plain URL, no token — the sandbox injects credentials at clone time).
 * Reads creds from the environment — never prints the key.
 */
const apiUrl = (process.env.PAPERCLIP_API_URL || '').trim().replace(/\/$/, '');
const apiKey = (process.env.PAPERCLIP_API_KEY || '').trim();
const companyId = (process.env.PAPERCLIP_COMPANY_ID || '').trim();
const projectIdOverride = (process.env.PROJECT_ID || '').trim();
const repoUrl = (process.env.REPO_URL || 'https://github.com/phumblot-gs/gs-backoffice.git').trim();
const defaultRef = (process.env.DEFAULT_REF || 'main').trim();
const apply = process.env.APPLY === '1';

if (!apiUrl || !apiKey || !companyId) {
  console.error('Set PAPERCLIP_API_URL, PAPERCLIP_API_KEY and PAPERCLIP_COMPANY_ID first.');
  process.exit(2);
}

async function api(method, path, body) {
  const res = await fetch(`${apiUrl}/api${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → HTTP ${res.status}: ${raw.slice(0, 400)}`);
  return raw ? JSON.parse(raw) : {};
}

const asArray = (v, ...keys) => {
  if (Array.isArray(v)) return v;
  for (const k of keys) if (Array.isArray(v?.[k])) return v[k];
  return [];
};

// 1. Resolve the project.
let projectId = projectIdOverride;
if (!projectId) {
  const projects = asArray(
    await api('GET', `/companies/${companyId}/projects`),
    'projects',
    'data',
  );
  const proj = projects.find((p) => String(p.name ?? '').toLowerCase() === 'gs-backoffice');
  if (!proj) {
    console.error(
      `Project "gs-backoffice" not found. Set PROJECT_ID explicitly.\n` +
        `Projects: ${projects.map((p) => `${p.id}:${p.name}`).join(', ') || '(none)'}`,
    );
    process.exit(1);
  }
  projectId = String(proj.id);
}

// 2. Inspect current state.
const project = await api('GET', `/projects/${projectId}`);
const policy = project.executionWorkspacePolicy ?? null;
const strategyType =
  policy?.workspaceStrategy?.type ?? policy?.config?.workspaceStrategy?.type ?? null;
const codebase = project.codebase ?? {};
const workspaces = asArray(project.workspaces);
const primary = project.primaryWorkspace ?? workspaces.find((w) => w.isPrimary) ?? null;

const engineers = asArray(
  await api('GET', `/companies/${companyId}/agents`),
  'agents',
  'data',
).filter((a) => String(a.role ?? '') === 'engineer');

console.log(`Project: ${project.name ?? '?'} (${projectId})`);
console.log(`  leadAgentId:            ${project.leadAgentId ?? '(none)'}`);
console.log(
  `  executionWorkspacePolicy: ${policy ? `enabled=${policy.enabled ?? '?'}, strategy=${strategyType ?? '(default project_primary)'}` : '(none)'}`,
);
console.log(`  codebase.repoUrl:       ${codebase.repoUrl ?? '(none)'}`);
console.log(
  `  codebase.defaultRef:    ${codebase.defaultRef ?? '(none)'}  origin: ${codebase.origin ?? '?'}`,
);
console.log(
  `  primary workspace:      ${primary ? `${primary.id} (sourceType=${primary.sourceType}, cwd=${primary.cwd ?? 'null'}, repoUrl=${primary.repoUrl ?? 'null'})` : '(none)'}`,
);
console.log(
  `  engineer agent(s):      ${engineers.map((a) => `${a.id}:${a.name ?? a.role}`).join(', ') || '(NONE — create one with role "engineer")'}`,
);

// 3. Isolation verdict.
const hostCheckout = policy?.enabled === true && strategyType === 'git_worktree';
console.log(
  `\nIsolation: host checkout at run time = ${hostCheckout ? 'YES ⚠️ (git_worktree policy enabled)' : 'NO ✅ (no git_worktree policy)'}`,
);
if (hostCheckout) {
  console.error(
    'ABORT: executionWorkspacePolicy uses git_worktree → runs would checkout on the Paperclip host, ' +
      'breaking sandbox isolation. Disable that policy before binding a repoUrl.',
  );
  process.exit(1);
}

// 4. Idempotency.
if (String(codebase.repoUrl ?? '') === repoUrl) {
  console.log(`\n✓ codebase.repoUrl already = ${repoUrl}. Nothing to do.`);
  process.exit(0);
}

// 5. Apply (gated).
if (!apply) {
  console.log(
    `\nDRY RUN. Would set the project's PRIMARY workspace repoUrl to:\n  ${repoUrl} (defaultRef ${defaultRef})\n` +
      `Re-run with APPLY=1 to bind. (No host clone occurs — pure metadata insert.)`,
  );
  process.exit(0);
}

console.log(`\nBinding repoUrl=${repoUrl} (defaultRef=${defaultRef}) as a new PRIMARY workspace…`);
const created = await api('POST', `/projects/${projectId}/workspaces`, {
  name: 'gs-backoffice',
  sourceType: 'git_repo',
  repoUrl,
  defaultRef,
  isPrimary: true,
});
console.log(`✓ Created primary workspace ${created.id ?? '?'}.`);

// 6. Re-read + report the new codebase so we can confirm the bridge will resolve it.
const after = await api('GET', `/projects/${projectId}`);
console.log(`\nAfter binding:`);
console.log(`  codebase.repoUrl:    ${after.codebase?.repoUrl ?? '(none)'}`);
console.log(
  `  codebase.defaultRef: ${after.codebase?.defaultRef ?? '(none)'}  origin: ${after.codebase?.origin ?? '?'}`,
);
console.log(
  `  primary workspace:   ${after.primaryWorkspace ? `${after.primaryWorkspace.id} (cwd=${after.primaryWorkspace.cwd ?? 'null'})` : '(none)'}`,
);
console.log(
  '\nThe bridge will now resolve repoUrl + the engineer from project context. ' +
    'Recommended: run one trivial evolution to confirm the loop still starts cleanly.',
);
