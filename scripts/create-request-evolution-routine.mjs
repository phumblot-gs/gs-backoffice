#!/usr/bin/env node
/**
 * Create the `request_evolution` official process as a Paperclip routine.
 *
 * This is the runtime half of the request-evolution feature (the code half — RBAC
 * catalog + CEO-gate events — ships in the repo). The routine is **sensitive** (title
 * starts with `!`) and carries the code `(request_evolution)`, so:
 *   - only groups whose workflow allowlist contains the code (today: leadership via
 *     `*`) can trigger it through henri_start_workflow;
 *   - triggering it does NOT run it — the MCP server creates an approval request and
 *     waits for a leadership approver (≠ requester); on approval the routine runs and
 *     wakes the Methods Officer to drive the self-evolution loop.
 *
 * Idempotent: if a routine already carries the `(request_evolution)` code, it does
 * nothing. Reads creds from the environment — never prints the key.
 *
 *   PAPERCLIP_API_URL=…  PAPERCLIP_API_KEY=…  PAPERCLIP_COMPANY_ID=… \
 *     [MO_AGENT_ID=…]  node scripts/create-request-evolution-routine.mjs
 *
 * MO_AGENT_ID is optional: if omitted, the script resolves the Methods Officer by
 * role/name from the company's agents.
 */
const apiUrl = (process.env.PAPERCLIP_API_URL || '').trim().replace(/\/$/, '');
const apiKey = (process.env.PAPERCLIP_API_KEY || '').trim();
const companyId = (process.env.PAPERCLIP_COMPANY_ID || '').trim();
const moAgentOverride = (process.env.MO_AGENT_ID || '').trim();

if (!apiUrl || !apiKey || !companyId) {
  console.error('Set PAPERCLIP_API_URL, PAPERCLIP_API_KEY and PAPERCLIP_COMPANY_ID first.');
  process.exit(2);
}

const CODE = 'request_evolution';
const TITLE = `!Request an evolution of Henri (${CODE})`;
const DESCRIPTION = [
  'A leadership-approved request to evolve Henri (the back office) has been accepted.',
  '',
  'The requested evolution is:',
  '{{request}}',
  '',
  'Act as the Methods Officer and drive it through the self-development loop:',
  '1. Analyse the request against the current codebase and processes.',
  '2. Produce a concrete plan, then decompose it into one verifiable step at a time',
  '   for the Engineer using create_child_issue (each with acceptance criteria).',
  '3. Drive the Engineer loop (sandbox coding + verification), review the diff, and',
  '   open a pull request with open_pr when the change is ready.',
  '4. Keep your issue updated with report_progress; set it to in_review/blocked if you',
  '   need a human, or done when the PR is open.',
  '',
  'Hard rules: a human merges the PR and approves the deploy — never bypass that.',
].join('\n');

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
  if (!res.ok) throw new Error(`${method} ${path} → HTTP ${res.status}: ${raw.slice(0, 300)}`);
  return raw ? JSON.parse(raw) : {};
}

function extractCode(title) {
  const m = (title || '').match(/\(([A-Za-z0-9][A-Za-z0-9_-]*)\)\s*$/);
  return m ? m[1] : null;
}

// 1. Idempotency — bail if the process already exists.
const routinesRaw = await api('GET', `/companies/${companyId}/routines`);
const routines = Array.isArray(routinesRaw)
  ? routinesRaw
  : (routinesRaw.routines ?? routinesRaw.data ?? []);
const existing = routines.find((r) => extractCode(r.title)?.toLowerCase() === CODE);
if (existing) {
  console.log(
    `Routine "${CODE}" already exists (id: ${existing.id}, title: "${existing.title}"). Nothing to do.`,
  );
  process.exit(0);
}

// 2. Resolve the Methods Officer agent.
let moAgentId = moAgentOverride;
if (!moAgentId) {
  const agentsRaw = await api('GET', `/companies/${companyId}/agents`);
  const agents = Array.isArray(agentsRaw) ? agentsRaw : (agentsRaw.agents ?? agentsRaw.data ?? []);
  const mo = agents.find((a) => {
    const role = String(a.role ?? '').toLowerCase();
    const name = String(a.name ?? '').toLowerCase();
    return role.includes('method') || name.includes('method') || name.includes('méthode');
  });
  if (!mo) {
    console.error(
      `Could not resolve the Methods Officer agent automatically. Re-run with MO_AGENT_ID set.\nAgents: ${agents.map((a) => `${a.id}:${a.name ?? a.role ?? '?'}`).join(', ')}`,
    );
    process.exit(1);
  }
  moAgentId = String(mo.id);
  console.log(`Resolved Methods Officer: ${mo.name ?? mo.role} (${moAgentId})`);
}

// 3. Create the sensitive, leadership-reserved routine.
const created = await api('POST', `/companies/${companyId}/routines`, {
  title: TITLE,
  description: DESCRIPTION,
  assigneeAgentId: moAgentId,
  priority: 'high',
  status: 'active',
  variables: [
    {
      name: 'request',
      label: 'What should change in Henri?',
      type: 'text',
      required: true,
    },
  ],
});
console.log(`✓ Created routine "${TITLE}" (id: ${created.id ?? '?'}).`);
console.log(
  'It is sensitive (leadership-only) and triggered via henri_start_workflow request_evolution ' +
    'with a `request` parameter. Approval runs it and wakes the Methods Officer.',
);
