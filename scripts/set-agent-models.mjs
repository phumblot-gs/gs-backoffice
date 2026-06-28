#!/usr/bin/env node
/**
 * Set each agent's ORCHESTRATION model (adapterConfig.model) by role, to cut cost —
 * everything was on Opus. Mapping (overridable via env):
 *   - engineer        → Haiku   (it only drives tools; the real coding runs in-sandbox)
 *   - ceo             → Haiku   (it only approves)
 *   - cto / "method*" → Sonnet  (Methods Officer: planning + diff review; Opus reserved
 *                                for high/critical evolutions — handled separately)
 * The IN-SANDBOX coding model is NOT set here (it's per `sandbox_code_task` call).
 *
 * SAFETY: merges ONLY `model` into the agent's EXISTING adapterConfig, so the locked
 * `extraArgs` (--mcp-config + --allowedTools) are preserved; verifies that after. Resets
 * the agent's runtime-state session so the new model takes effect. Read-only unless APPLY=1.
 *
 *   PAPERCLIP_API_URL=… PAPERCLIP_API_KEY=… PAPERCLIP_COMPANY_ID=… [APPLY=1] \
 *     [MO_MODEL=…] [ENGINEER_MODEL=…] [CEO_MODEL=…] node scripts/set-agent-models.mjs
 */
const apiUrl = (process.env.PAPERCLIP_API_URL || '').trim().replace(/\/$/, '');
const apiKey = (process.env.PAPERCLIP_API_KEY || '').trim();
const companyId = (process.env.PAPERCLIP_COMPANY_ID || '').trim();
const apply = process.env.APPLY === '1';

const MO_MODEL = (process.env.MO_MODEL || 'claude-sonnet-4-6').trim();
const ENGINEER_MODEL = (process.env.ENGINEER_MODEL || 'claude-haiku-4-5-20251001').trim();
const CEO_MODEL = (process.env.CEO_MODEL || 'claude-haiku-4-5-20251001').trim();

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
  return { ok: res.ok, status: res.status, raw: await res.text() };
}
const asArray = (v, ...keys) => {
  if (Array.isArray(v)) return v;
  for (const k of keys) if (Array.isArray(v?.[k])) return v[k];
  return [];
};

function targetFor(agent) {
  const role = String(agent.role || '').toLowerCase();
  const name = String(agent.name || '').toLowerCase();
  if (role === 'engineer') return ENGINEER_MODEL;
  if (role === 'ceo') return CEO_MODEL;
  if (role === 'cto' || name.includes('method') || name.includes('méthode')) return MO_MODEL;
  return null; // leave anything else untouched
}

async function patchAgent(id, adapterConfig) {
  for (const path of [`/companies/${companyId}/agents/${id}`, `/agents/${id}`]) {
    const r = await api('PATCH', path, { adapterConfig });
    if (r.ok) return { path, ok: true };
    if (r.status !== 404) return { path, ok: false, status: r.status, raw: r.raw };
  }
  return { ok: false, status: 404, raw: 'no agent update route matched' };
}
async function resetSession(id) {
  for (const path of [
    `/agents/${id}/runtime-state/reset-session`,
    `/companies/${companyId}/agents/${id}/runtime-state/reset-session`,
  ]) {
    const r = await api('POST', path, {});
    if (r.ok) return path;
    if (r.status !== 404) return `(${path} → HTTP ${r.status})`;
  }
  return '(no reset-session route matched — may be unnecessary)';
}

const list = await api('GET', `/companies/${companyId}/agents`);
const agents = asArray(JSON.parse(list.raw), 'agents', 'data');

let changed = 0;
for (const a of agents) {
  const target = targetFor(a);
  const cur = (a.adapterConfig || {}).model || '(default)';
  if (!target) {
    console.log(`· ${a.name} [${a.role}] model=${cur} — left untouched`);
    continue;
  }
  if (cur === target) {
    console.log(`✓ ${a.name} [${a.role}] already ${target}`);
    continue;
  }
  console.log(`→ ${a.name} [${a.role}] ${cur}  ⇒  ${target}`);
  if (!apply) {
    changed += 1;
    continue;
  }
  const merged = { ...(a.adapterConfig || {}), model: target };
  const beforeArgs = JSON.stringify((a.adapterConfig || {}).extraArgs || []);
  const res = await patchAgent(a.id, merged);
  if (!res.ok) {
    console.error(`  PATCH failed (HTTP ${res.status}): ${String(res.raw).slice(0, 160)}`);
    continue;
  }
  const reset = await resetSession(a.id);
  // Verify: model changed AND extraArgs preserved.
  const after = asArray(
    JSON.parse((await api('GET', `/companies/${companyId}/agents`)).raw),
    'agents',
    'data',
  ).find((x) => x.id === a.id);
  const afterArgs = JSON.stringify((after?.adapterConfig || {}).extraArgs || []);
  const okModel = (after?.adapterConfig || {}).model === target;
  const okArgs = afterArgs === beforeArgs;
  console.log(
    `  applied via ${res.path}; reset=${reset}; model=${okModel ? 'OK' : 'MISMATCH'}; extraArgs preserved=${okArgs}`,
  );
  if (!okArgs)
    console.error('  ⚠️ extraArgs changed — investigate (locked toolset must be intact).');
  changed += 1;
}

console.log(
  apply
    ? `\nDone. ${changed} agent(s) updated.`
    : `\nDRY RUN. ${changed} agent(s) would change. Re-run with APPLY=1.`,
);
