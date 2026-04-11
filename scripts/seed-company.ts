#!/usr/bin/env tsx
/**
 * Seed script for Paperclip: creates the GRAFMAKER company and 6 agents.
 *
 * Usage:
 *   PAPERCLIP_API_URL=http://localhost:3100 tsx scripts/seed-company.ts
 */

const PAPERCLIP_API_URL = (process.env.PAPERCLIP_API_URL ?? 'http://localhost:3100').replace(
  /\/$/,
  '',
);

interface AgentDef {
  name: string;
  role: string;
  description: string;
  heartbeatCron: string;
  monthlyBudgetUsd: number;
  reportsTo: string | null;
}

// Paperclip roles are enum: ceo, cto, cmo, cfo, engineer, designer, pm, qa, devops, researcher, general
// We map our backoffice roles to the closest Paperclip role
const AGENTS: AgentDef[] = [
  {
    name: 'Chef de Cabinet',
    role: 'ceo', // Chief of Staff → closest to CEO in Paperclip's org model
    description:
      'Routes employee requests to the right agent. Produces weekly internal digests. Publishes digests to Google Chat via EVT. Escalates unresolved tickets.',
    heartbeatCron: '0 9 * * 5', // Friday 9:00 Paris
    monthlyBudgetUsd: 40,
    reportsTo: null,
  },
  {
    name: 'Responsable Méthodes',
    role: 'engineer', // Methods Officer → implements code changes
    description:
      'Maintains all business process documentation in Notion. Identifies gaps, proposes new workflows. Can invoke Claude Code (headless) to implement changes.',
    heartbeatCron: '0 10 * * 1', // Monday 10:00
    monthlyBudgetUsd: 60,
    reportsTo: 'ceo',
  },
  {
    name: 'Responsable Données',
    role: 'researcher', // Data Officer → data analysis
    description:
      'Runs consistency checks across all data registries. Alerts when inconsistencies are found. Answers data queries with RBAC enforcement.',
    heartbeatCron: '0 7 * * 1-5', // Weekdays 7:00
    monthlyBudgetUsd: 50,
    reportsTo: 'ceo',
  },
  {
    name: 'Responsable Finance',
    role: 'cfo', // Finance → CFO
    description:
      'Executes invoicing workflows. Monitors overdue invoices. Assists with Pennylane reconciliation.',
    heartbeatCron: '0 8 * * 1-5', // Weekdays 8:00
    monthlyBudgetUsd: 50,
    reportsTo: 'ceo',
  },
  {
    name: 'Responsable RH',
    role: 'pm', // HR → closest to PM (people management)
    description:
      'Answers HR process questions. Tracks HR deadlines (probation, training, contract renewals). Maintains HR knowledge base in Notion.',
    heartbeatCron: '0 9 * * 1', // Monday 9:00
    monthlyBudgetUsd: 30,
    reportsTo: 'ceo',
  },
  {
    name: 'Sales Ops',
    role: 'cmo', // Sales Ops → closest to CMO
    description:
      'Registers signed contracts. Updates HubSpot pipeline. Prepares prospect briefings.',
    heartbeatCron: '0 8 * * 1-5', // Weekdays 8:00
    monthlyBudgetUsd: 40,
    reportsTo: 'ceo',
  },
];

async function apiRequest(method: string, path: string, body?: unknown): Promise<unknown> {
  const url = `${PAPERCLIP_API_URL}/api${path}`;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body) headers['Content-Type'] = 'application/json';

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${path} failed: ${res.status} — ${text}`);
  }

  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function main() {
  console.info(`\n🏢 Seeding Paperclip at ${PAPERCLIP_API_URL}\n`);

  // 1. Check health
  try {
    const health = await fetch(`${PAPERCLIP_API_URL}/api/health`);
    if (!health.ok) throw new Error(`Health check failed: ${health.status}`);
    console.info('✅ Paperclip is running');
  } catch (error) {
    console.error(`❌ Cannot reach Paperclip at ${PAPERCLIP_API_URL}`);
    console.error('   Start Paperclip first: docker compose -f docker/docker-compose.yml up -d');
    process.exit(1);
  }

  // 2. Create company
  console.info('\n📋 Creating company GRAFMAKER...');
  const company = (await apiRequest('POST', '/companies', {
    name: 'GRAFMAKER',
    mission:
      'Run a virtual AI-powered back office that assists ~30 employees on daily operations: answering process questions, executing business workflows, verifying data consistency, and proactively broadcasting internal digests.',
  })) as { id: string; name: string };
  console.info(`   Company created: ${company.name} (${company.id})`);

  // 3. Create agents
  console.info('\n👥 Creating agents...');
  const agentIds: Record<string, string> = {};

  for (const agentDef of AGENTS) {
    const agent = (await apiRequest('POST', `/companies/${company.id}/agents`, {
      name: agentDef.name,
      role: agentDef.role,
      description: agentDef.description,
      adapterType: 'claude_local',
      config: {
        heartbeatCron: agentDef.heartbeatCron,
        model: 'claude-sonnet-4-20250514',
      },
    })) as { id: string; name: string };

    agentIds[agentDef.role] = agent.id;
    console.info(`   ✅ ${agentDef.name} (${agentDef.role}) — ${agent.id}`);
  }

  // 4. Summary
  console.info('\n🎉 Seed complete!\n');
  console.info('Company ID:', company.id);
  console.info('Agent IDs:');
  for (const [role, id] of Object.entries(agentIds)) {
    console.info(`  ${role}: ${id}`);
  }
  console.info('\nAdd these to your .env:');
  console.info(`  PAPERCLIP_COMPANY_ID=${company.id}`);
  console.info(`  CHIEF_OF_STAFF_AGENT_ID=${agentIds['ceo']}`);
  console.info('');
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
