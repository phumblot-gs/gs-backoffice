# GRAFMAKER Back Office — Claude Code Project Prompt

## Identity

You are bootstrapping **gs-backoffice**, the internal AI-powered back office for GRAFMAKER SAS (~30 people, France/Poland/Spain/India). The project uses the **Paperclip** open-source framework (https://github.com/paperclipai/paperclip) to orchestrate a team of AI agents that assist employees on daily operations: answering process questions, executing business workflows, verifying data consistency, and proactively broadcasting internal digests.

The architecture, deployment strategy, and CI/CD pipeline follow the patterns established by the **EVT (Events Platform)** module — the company's real-time event system already in production on AWS. EVT is also used as the internal message bus: agents publish and consume events through it.

---

## 1. Project Overview

### What we're building

A "virtual back office company" running on Paperclip with three layers:

- **Claude.ai** = the interactive front door (employees ask questions and trigger workflows directly from Claude, via a custom MCP server that exposes back office capabilities)
- **Paperclip** = the autonomous engine (heartbeats, digests, consistency checks, ticket management, agent orchestration)
- **EVT (gs-stream-events)** = the event bus connecting everything (agents publish events, consume events from other agents and from the GS ecosystem, and route notifications)

### Agent Roles

| Agent | Domain | Key Responsibilities |
|---|---|---|
| **Chief of Staff** | Routing, Comms & Coordination | Receives employee requests (via Claude.ai MCP), routes to the right agent, produces periodic digests, acts as the main interface |
| **Methods Officer** | Processes & Documentation | Maintains and evolves all business process documentation in Notion. Identifies gaps, proposes new workflows. Can invoke Claude Code (headless) to implement changes to this project, subject to human approval. |
| **Data Officer** | Data Integrity & BI | Monitors all company data registries for consistency. Runs scheduled checks against defined rules. Alerts the right people when inconsistencies are found. Answers data queries with access control enforcement. |
| **Finance Agent** | Billing & Accounting | Executes invoicing workflows, monitors payment status, interacts with Hyperline and Pennylane |
| **HR Agent** | People Ops | Answers HR process questions, tracks deadlines (probation, training), maintains HR knowledge base |
| **Sales Ops Agent** | CRM & Contracts | Registers signed contracts, updates HubSpot, prepares prospect briefs |

### Key Principles

- **Multilingual**: Agents communicate with employees in whatever language they use (French, English, Polish, Spanish, etc.). All code, comments, and documentation are in English.
- **Human-in-the-loop**: No agent can send an invoice, sign a contract, or make a payment without explicit human validation. Agents create drafts and notify — humans approve.
- **Iterative process building**: Business workflows are NOT hardcoded in this prompt. They are built collaboratively with the Methods Officer agent once in production. The Methods Officer proposes, the CEO validates, and the Methods Officer implements.
- **Event-driven**: Agents communicate and trigger actions through EVT events, not direct calls.

---

## 2. Technical Stack

### Core

- **Runtime**: Node.js 22.x
- **Framework**: Paperclip (self-hosted, MIT, PostgreSQL-backed)
- **Language**: TypeScript (strict mode)
- **Package Manager**: pnpm
- **Monorepo**: pnpm workspaces + Turborepo

### Infrastructure (AWS)

- **Compute**: ECS Fargate (Paperclip server + agent runners)
- **Database**: RDS PostgreSQL 16 (db.t4g.micro for staging, db.t4g.small for production) — Paperclip's state store only. Low volume (~30 users, ~6 agents), managed service, ~$15-30/month staging.
- **Messaging**: EVT (gs-stream-events) — the existing internal event platform on AWS (Lambda + Aurora + SNS/SQS). Agents publish and consume events via the EVT API and event queues.
- **Networking**: VPC, private subnets, NAT Gateway, ALB
- **Secrets**: AWS Secrets Manager
- **IaC**: Terraform (modular, per-environment)
- **Monitoring**: CloudWatch + Sentry
- **CI/CD**: GitHub Actions

### Why RDS PostgreSQL and not Aurora Serverless

Paperclip needs a PostgreSQL instance for its own state (tickets, agents, org chart, budgets). The volume is extremely low (~30 users, ~6 agents, a few hundred tickets/month). RDS PostgreSQL on a small instance is the right cost/complexity trade-off. All inter-agent messaging goes through EVT, not the database.

### External Integrations

| Service | Purpose | Integration Method |
|---|---|---|
| **EVT (gs-stream-events)** | Event bus — publish/consume business events, route notifications | REST API (`api.events.grand-shooting.com`) + SQS queues |
| **Notion** | Knowledge base (processes, modules, features, NDAs, docs) | MCP `https://mcp.notion.com/mcp` |
| **Asana** | Task tracking, sprint data | MCP `https://mcp.asana.com/sse` |
| **HubSpot** | CRM — contacts, clients, deals, interactions | MCP `https://mcp.hubspot.com/anthropic` |
| **Hyperline** | Billing — invoices, subscriptions, customers | MCP `https://mcp.hyperline.co/mcp` |
| **Linear** | Product roadmap, bug tracking | MCP (to configure) |
| **Google Drive** | Templates, shared documents, NDA storage | MCP `https://drivemcp.googleapis.com/mcp/v1` |
| **Pennylane** | Accounting, AP control | REST API v2 (custom adapter) |
| **Spendesk** | Purchase invoices registry (account not yet created) | REST API (future — adapter to build when available) |
| **JumpCloud** | Identity & access management — user groups for RBAC | REST API v2 (`console.jumpcloud.com/api/v2`) |
| **Google Chat** | Notifications, digests (via EVT events → webhook) | EVT consumer → Google Chat webhook |
| **Gmail** | Email notifications | MCP `https://gmail.mcp.claude.com/mcp` |
| **Anthropic API** | Agent LLM backbone | Claude Sonnet 4 via API |
| **Claude Code** | Headless code generation (used by Methods Officer) | CLI `claude -p` with `--output-format json` |

---

## 3. Architecture: How EVT Connects Everything

### Event Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                        CLAUDE.AI (Employee)                         │
│                    Custom MCP Server: gs-backoffice                  │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ (MCP call)
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     PAPERCLIP (Orchestrator)                        │
│                                                                     │
│  Chief of Staff ─── Methods Officer                                 │
│       │              │                                              │
│       ├── Finance    ├── Data Officer                               │
│       ├── HR                                                        │
│       └── Sales Ops                                                 │
│                                                                     │
│  Each agent publishes/consumes via EVT                              │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    EVT (gs-stream-events)                           │
│                                                                     │
│  SNS Topic: gs-events-{env}                                        │
│    ├── Queue: gs-queue-backoffice-finance    (billing.* events)     │
│    ├── Queue: gs-queue-backoffice-data       (*.* all events)       │
│    ├── Queue: gs-queue-backoffice-notify     (backoffice.notify.*)  │
│    │       └── Consumer: Google Chat webhook forwarder              │
│    └── Queue: gs-queue-backoffice-methods    (backoffice.process.*) │
│                                                                     │
│  Agents publish events like:                                        │
│    backoffice.invoice.draft_created                                 │
│    backoffice.contract.registered                                   │
│    backoffice.consistency.alert                                     │
│    backoffice.digest.published                                      │
│    backoffice.process.updated                                       │
│    backoffice.notify.google_chat                                    │
└─────────────────────────────────────────────────────────────────────┘
```

### EVT Integration Pattern

Agents interact with EVT through the `packages/integrations/evt/` adapter:

- **Publishing**: `POST /v1/events` with event type, actor, scope, payload
- **Consuming**: Long-polling on dedicated SQS queues via `GET /v1/queues/:name/messages`
- **Acknowledging**: `DELETE /v1/queues/:name/messages` after processing
- **Notifications**: To send a Google Chat message, publish a `backoffice.notify.google_chat` event. A lightweight consumer (Lambda or ECS task) listens on the notify queue and forwards to the appropriate Google Chat webhook.

Each agent gets its own EVT API key with scoped permissions.

---

## 4. Claude.ai as Employee Interface (Custom MCP Server)

Employees interact with the back office directly from Claude.ai via a **custom MCP server** (`gs-backoffice-mcp`) that exposes the following tools:

### MCP Tools to Implement

```typescript
// Tools exposed to Claude.ai users:

// Process Q&A
"backoffice_ask"          // Ask any question about internal processes
                          // → Chief of Staff routes to the right agent or Notion

// Workflow triggers
"backoffice_start_workflow" // Start a business workflow (e.g., "invoice client X")
                           // → Creates a Paperclip ticket, returns ticket ID

// Ticket interaction
"backoffice_ticket_update" // Upload a file, add info to an existing ticket
"backoffice_ticket_status" // Check status of a ticket

// Data queries (with RBAC)
"backoffice_data_query"    // Ask for data from any registry
                           // → Data Officer checks permissions via JumpCloud
                           //   groups before responding

// Digest
"backoffice_digest"        // Get the latest internal digest
```

### Authentication Flow

1. Employee is authenticated in Claude.ai (their Anthropic account)
2. MCP server receives the request with the employee's identity
3. MCP server resolves the employee's JumpCloud groups via `GET /v2/users/{userId}/memberof`
4. Permissions are checked against the RBAC matrix before any data is returned

---

## 5. Access Control (JumpCloud RBAC)

### Architecture

Permissions are derived from JumpCloud user groups. Each employee belongs to one or more groups, and each group has specific data access rights.

### JumpCloud API Integration

```typescript
// packages/integrations/jumpcloud/

// Resolve user's groups
// GET /v2/users/{userId}/memberof
// Headers: x-api-key: {JUMPCLOUD_API_KEY}

// List group members (for validation)
// GET /v2/usergroups/{groupId}/members
```

### RBAC Matrix (configurable in Notion or config file)

```typescript
// Example structure — actual matrix to be defined with Methods Officer
interface RBACConfig {
  groups: {
    [groupName: string]: {
      dataSources: {
        hubspot?: { read: boolean; scopes: string[] };      // e.g., ["contacts", "deals"]
        hyperline?: { read: boolean; scopes: string[] };     // e.g., ["invoices", "subscriptions"]
        pennylane?: { read: boolean; scopes: string[] };
        linear?: { read: boolean; scopes: string[] };
        evt?: { read: boolean; eventTypes: string[] };
        notion?: { read: boolean; databases: string[] };
      };
      agents: string[];  // Which agents this group can interact with
    };
  };
}
```

### Where RBAC Config Lives

The RBAC matrix is stored in a dedicated Notion database (managed by the Methods Officer), synced to a config file in the repo on each deploy. This allows non-technical updates to permissions while keeping the runtime config fast.

---

## 6. Agent Definitions

### Chief of Staff

```yaml
name: "Chef de Cabinet"
role: chief-of-staff
reportsTo: null  # Top of org
heartbeat: "0 9 * * 5"  # Friday 9:00 Paris — weekly digest
monthlyBudget: 40  # USD
responsibilities:
  - Route employee requests to the right agent
  - Produce weekly internal digest (aggregate from Asana, HubSpot, Hyperline, Linear)
  - Publish digest to Google Chat via EVT
  - Escalate unresolved tickets
integrations: [notion, asana, hubspot, hyperline, evt, google-chat]
evt_publishes: [backoffice.digest.*, backoffice.notify.*]
evt_consumes: [backoffice.*.completed, backoffice.*.failed]
```

### Methods Officer

```yaml
name: "Responsable Méthodes"
role: methods-officer
reportsTo: chief-of-staff
heartbeat: "0 10 * * 1"  # Monday 10:00 — weekly process review
monthlyBudget: 60  # USD (higher — invokes Claude Code)
responsibilities:
  - Maintain all business process documentation in Notion
  - Ensure consistency across process docs (no contradictions, no gaps)
  - Identify when new workflows or integrations are needed
  - Propose evolutions to the CEO (via Paperclip ticket)
  - Once approved, invoke Claude Code (headless) to implement changes
  - Create PRs, run tests on staging, request deployment approval
integrations: [notion, evt, claude-code]
evt_publishes: [backoffice.process.*, backoffice.evolution.*]
evt_consumes: [backoffice.*.completed]
claude_code:
  enabled: true
  permission_mode: "acceptEdits"
  allowed_tools: ["Read", "Write", "Edit", "Bash(pnpm *)", "Bash(git *)"]
  max_turns: 20
  approval_gates:
    - before_implementation: true   # CEO must approve the proposal
    - before_commit: true           # CEO must approve the PR
    - before_deploy: true           # CEO must approve staging → production
```

### Data Officer

```yaml
name: "Responsable Données"
role: data-officer
reportsTo: chief-of-staff
heartbeat: "0 7 * * 1-5"  # Weekdays 7:00 — daily consistency check
monthlyBudget: 50  # USD
responsibilities:
  - Run consistency checks across all data registries
  - Alert the right people when inconsistencies are found
  - Answer data queries (with RBAC enforcement via JumpCloud)
  - Maintain the consistency rules catalog in Notion
integrations: [hubspot, hyperline, linear, evt, notion, jumpcloud, pennylane]
evt_publishes: [backoffice.consistency.*, backoffice.data.*, backoffice.notify.*]
evt_consumes: [*.*]  # Consumes all events for data monitoring

registries:
  hubspot:
    type: CRM
    example_rules:
      - "Tasks overdue by more than 3 days → alert task owner"
      - "Deal marked Closed Won without associated Hyperline subscription → alert Sales Ops"
      - "Contact without email → flag for cleanup"
  hyperline:
    type: Billing
    example_rules:
      - "Active subscription without corresponding HubSpot deal → alert Finance"
      - "ARR mismatch between HubSpot deal amount and Hyperline subscription → alert Finance"
      - "Draft invoice older than 7 days → alert Finance"
  notion:
    type: Documentation
    example_rules:
      - "NDA registered in Notion without linked document in Google Drive → alert Legal"
      - "Module with status Validated but no repository_url → alert Engineering"
      - "Process doc not updated in 6 months → flag for Methods Officer review"
  linear:
    type: Product
    example_rules:
      - "Bug marked Critical without assignee → alert CTO"
      - "Ticket in In Progress for more than 2 weeks → alert project lead"
  evt:
    type: Events
    example_rules:
      - "Event ingestion gap > 1 hour → alert Engineering"
  spendesk:
    type: Procurement
    status: "future — account not yet created"
```

### Finance Agent

```yaml
name: "Responsable Finance"
role: finance
reportsTo: chief-of-staff
heartbeat: "0 8 * * 1-5"
monthlyBudget: 50
responsibilities:
  - Execute invoicing workflows (details defined by Methods Officer)
  - Monitor overdue invoices
  - Assist with Pennylane reconciliation
integrations: [hyperline, pennylane, google-drive, evt, notion]
evt_publishes: [backoffice.invoice.*, backoffice.payment.*, backoffice.notify.*]
evt_consumes: [backoffice.finance.*, billing.*]
```

### HR Agent

```yaml
name: "Responsable RH"
role: hr
reportsTo: chief-of-staff
heartbeat: "0 9 * * 1"
monthlyBudget: 30
responsibilities:
  - Answer HR process questions
  - Track HR deadlines (probation, training, contract renewals)
  - Maintain HR knowledge base in Notion
integrations: [notion, jumpcloud, evt]
evt_publishes: [backoffice.hr.*, backoffice.notify.*]
evt_consumes: [backoffice.hr.*]
```

### Sales Ops Agent

```yaml
name: "Sales Ops"
role: sales-ops
reportsTo: chief-of-staff
heartbeat: "0 8 * * 1-5"
monthlyBudget: 40
responsibilities:
  - Register signed contracts (details defined by Methods Officer)
  - Update HubSpot pipeline
  - Prepare prospect briefings
integrations: [hubspot, hyperline, google-drive, notion, evt]
evt_publishes: [backoffice.contract.*, backoffice.deal.*, backoffice.notify.*]
evt_consumes: [backoffice.sales.*]
```

---

## 7. Methods Officer — Self-Evolution Mechanism

The Methods Officer is the only agent that can modify this project's codebase.

### Governance Flow

1. **Identification** — Agent spots a gap (missing process, needed integration, employee question it couldn't answer)
2. **Proposal** — Creates a Paperclip ticket with: problem, proposed solution, impact, Claude Code prompt draft
3. **Approval Gate** — CEO reviews. Approve / request changes / reject.
4. **Implementation** — Methods Officer invokes Claude Code headless:
   ```bash
   claude -p "<prompt>" \
     --allowedTools "Read" "Write" "Edit" "Bash(pnpm *)" "Bash(git *)" \
     --permission-mode acceptEdits \
     --max-turns 20 \
     --output-format json \
     --append-system-prompt "Working on gs-backoffice. Read CLAUDE.md first."
   ```
5. **PR & Review** — Creates branch `methods-officer/<ticket-id>`, implements, runs tests, creates PR
6. **Deploy** — CEO approves merge → pushes staging → Methods Officer runs smoke tests → CEO pushes production

---

## 8. Repository Structure

```
gs-backoffice/
├── .github/workflows/
│   ├── ci.yml                        # PR: lint, typecheck, tests
│   ├── deploy-staging.yml            # Push staging: build → ECR → Terraform → ECS → smoke
│   └── deploy-production.yml         # Push production: same + approval gate
├── apps/
│   ├── server/                       # Paperclip server
│   ├── agent-runner/                 # Agent execution runtime
│   └── mcp-server/                   # Custom MCP server for Claude.ai
│       └── src/
│           ├── tools/                # backoffice_ask, backoffice_data_query, etc.
│           ├── auth/                 # JumpCloud RBAC resolution
│           └── server.ts
├── packages/
│   ├── core/                         # Types, Zod schemas, RBAC utilities
│   ├── agents/                       # Agent configs, skills, prompts
│   │   └── src/{chief-of-staff,methods-officer,data-officer,finance,hr,sales-ops}/
│   ├── integrations/                 # External service adapters
│   │   └── src/{evt,notion,hyperline,hubspot,linear,pennylane,jumpcloud,google-chat,google-drive,claude-code,spendesk}/
│   ├── consistency/                  # Data Officer: rules, checkers, engine, alerts
│   └── knowledge/                    # Notion knowledge base query layer
├── infrastructure/terraform/
│   ├── modules/{networking,database,compute,load-balancer,secrets,monitoring}/
│   ├── environments/{staging,production}/
│   └── shared/
├── scripts/
│   ├── setup-local.sh
│   ├── seed-company.ts
│   ├── seed-evt-queues.ts
│   └── sync-rbac.ts
├── docker/
│   ├── docker-compose.yml            # Local: Paperclip + Postgres + mock EVT
│   └── docker-compose.test.yml
├── tests/{unit,integration,e2e}/
├── evals/
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── turbo.json
├── CLAUDE.md
└── README.md
```

---

## 9. Environments & Deployment

### Environment Matrix

| | Local | Staging | Production |
|---|---|---|---|
| **Compute** | Docker Compose | ECS Fargate | ECS Fargate |
| **Database** | PostgreSQL 16 (Docker) | RDS db.t4g.micro | RDS db.t4g.small |
| **EVT** | Mock EVT server (Docker) | EVT staging (`gs-stream-api-staging`) | EVT production |
| **MCP Server** | localhost:3001 | mcp-backoffice-staging.grand-shooting.com | mcp-backoffice.grand-shooting.com |
| **Agent budgets** | Unlimited | $50/month total | $300/month total |

### Branch Strategy

```
main ──── development (PRs here)
  ├── PR → main ──→ ci.yml (lint, typecheck, unit tests, integration tests)
  ├── push → staging ──→ deploy-staging.yml (Docker → ECR → Terraform → ECS → smoke → notify)
  └── push → production ──→ deploy-production.yml (same + approval gate)
```

### Environment Variables

```bash
# Paperclip
DATABASE_URL=postgresql://...
PAPERCLIP_PORT=3000
PAPERCLIP_SECRET=...

# Anthropic
ANTHROPIC_API_KEY=sk-ant-...

# EVT
EVT_API_URL=https://api.events.grand-shooting.com
EVT_API_KEY=gs_{env}_...

# MCP Auth Tokens
NOTION_MCP_TOKEN=...
ASANA_MCP_TOKEN=...
HUBSPOT_MCP_TOKEN=...
HYPERLINE_MCP_TOKEN=...
GOOGLE_DRIVE_MCP_TOKEN=...
GMAIL_MCP_TOKEN=...
LINEAR_MCP_TOKEN=...

# Direct APIs
PENNYLANE_API_TOKEN=...
JUMPCLOUD_API_KEY=...
JUMPCLOUD_ORG_ID=...

# Google Chat Webhooks (used by EVT consumer)
GOOGLE_CHAT_WEBHOOK_FINANCE=...
GOOGLE_CHAT_WEBHOOK_GENERAL=...

# Claude Code (Methods Officer)
CLAUDE_CODE_BINARY=claude
CLAUDE_CODE_ALLOWED_TOOLS=Read,Write,Edit,Bash(pnpm *),Bash(git *)

# Monitoring
SENTRY_DSN=...
NODE_ENV=development|staging|production
```

---

## 10. Coding Standards

- **TypeScript strict mode** everywhere
- **Zod** for all external data validation
- **Clean Architecture**: domain in `packages/core`, infra in `packages/integrations`
- **Error handling**: All MCP/EVT calls in try/catch with structured logging
- **Logging**: JSON via `pino` — agent name, ticket ID, workflow step, event ID
- **Tests**: 80%+ coverage on `packages/core`, `packages/consistency`, `packages/knowledge`
- **Commits**: Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`)
- **PRs**: All changes via PR to `main`. CI must pass.

---

## 11. Phase Plan

### Phase 1: Scaffolding (Week 1)
- Monorepo + TypeScript + ESLint + Prettier + Vitest + Turborepo
- Docker Compose (Paperclip + PostgreSQL + mock EVT)
- GitHub Actions CI
- Paperclip local install + seed script
- Verify: `pnpm install && pnpm build && pnpm test`

### Phase 2: Core (Week 2)
- EVT adapter (publish, consume, acknowledge)
- JumpCloud adapter (groups → RBAC)
- Notion knowledge base adapter
- MCP server skeleton with auth
- Chief of Staff with basic routing

### Phase 3: Methods Officer (Week 3)
- Methods Officer agent
- Claude Code headless adapter
- Approval gate workflow
- First self-test: Methods Officer documents its own processes

### Phase 4: Data Officer (Week 3-4)
- Consistency rule engine
- Registry adapters (HubSpot, Hyperline, Notion, Linear)
- Scheduled checks via heartbeat
- Alerts via EVT → Google Chat

### Phase 5: AWS (Week 4)
- Terraform modules
- Staging deploy + workflow
- Production deploy + approval gate

### Phase 6: Remaining Agents (Week 5-6)
- Finance, HR, Sales Ops (skeletons — workflows via Methods Officer)
- E2E testing

---

## 12. References

- **EVT**: https://www.notion.so/2f0582cb2b9c81868575f05f634266d6
- **Paperclip**: https://github.com/paperclipai/paperclip
- **Modules DB**: https://www.notion.so/216582cb2b9c8045881ae17bc1b78385
- **JumpCloud API v2**: https://docs.jumpcloud.com/api/2.0/index.html — key: `GET /v2/users/{userId}/memberof`, `GET /v2/usergroups/{groupId}/members`
- **Claude Code Headless**: https://code.claude.com/docs/en/headless
