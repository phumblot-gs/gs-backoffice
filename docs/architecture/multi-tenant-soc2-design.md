# Multi-tenant back office + SOC 2 — Design proposal

Status: **Draft for CEO review** · Author: Methods Officer (assisted) · Date: 2026-06-17
Scope decisions (confirmed): tenants = **internal GRAFMAKER entities** (row-scoping acceptable) ·
SOC 2 TSC = **Security + Confidentiality** · GRC platform = **Comp AI** (open source, evidence engine).

> This document is the architecture proposal for three capabilities requested by the CEO,
> designed to be **SOC 2 Type II ready** from day one. SOC 2 is ~80% process/evidence and
> ~20% technical: this covers the technical controls + the evidence each one must emit.
> An independent CPA auditor still issues the report; Comp AI only automates evidence.

---

## 1. Current state (foundation already in place)

- **Identity**: Google OAuth (`@grand-shooting.com`) → MCP session → email. Groups resolved via **JumpCloud** (`/v2/users/{id}/memberof` + group-name cache).
- **RBAC**: `config/rbac.json` maps JumpCloud groups → `{ services: { notion, paperclip }, workflows }`. Now **fail-closed** (unknown user / lookup error / unmapped group ⇒ zero access). Notion scopes standardized to English and matched to Notion section names.
- **Enforcement**: MCP plugin manager exposes a tool only if the user holds its `requiredPermission`; Notion further filters docs by `scopes.notion`.
- **Audit**: every tool call is published to **EVT** as an audit event (actor email, tool, input, success/error).
- **Paperclip**: single instance, **company-scoped API** (`/companies/{id}/...`), rich native APIs for companies, members, agents, **routines**, access/permissions, invites, instance admin; full **OpenAPI** spec via `paperclipai openapi`.
- **Change management**: PR → CI (install/build/typecheck/test/lint) → merge → push `staging`/`production` → Terraform/ECS. IaC in `infrastructure/terraform`.

**Known gaps closed recently**: fail-open RBAC; open public signup; hostile accounts/companies; broken JumpCloud group parsing. These are exactly the class of findings a SOC 2 audit raises — they are now fixed, but must be backed by _systematic controls + evidence_, not ad-hoc fixes.

---

## 2. Capability A — Per-company RBAC + multi-company MCP (Q1)

**Goal**: multiple internal companies; each company authorizes a set of `(group, scope/actions)`; a user's effective access on a company = **union** of scopes over their groups ∩ the company's authorized groups.

### Where access rights live (VALIDATED 2026-06-17)

Two distinct layers — do not conflate them:

| Layer                                      | What                                                                      | Where it lives                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **A. Employee access (via MCP/Claude.ai)** | `(company, group) → scopes` + **expert-agent access** + allowed workflows | **Version-controlled config (`config/rbac.json`), source of truth, changed via PR** |
| **B. Agent internal capabilities**         | what an expert agent may _do_ once invoked (skills, permissions)          | **Paperclip-native** (`agent permissions:update`, `principal_permission_grants`)    |

This question (employee rights on companies + expert-agent access) is **Layer A**.

**Why git config (not a Notion DB / free-form UI) as source of truth** — this is itself a SOC 2 control:

- **Change management (CC8)**: every rights change = a PR → independent review (**segregation of duties**) → CI → merge. Exactly what the auditor wants.
- **Immutable audit trail**: `git log` proves who changed which right, when, approved by whom — free evidence.
- **Validation**: Zod schema + CI check rejects malformed / over-permissive matrices before deploy.
- Loaded by the MCP at startup, deployed with the image (reproducible).
- _Optional later_: a Notion DB / admin UI as a **proposal** layer that opens a PR (never auto-applies), preserving non-technical editing **and** SOC 2 change control.

### Form — per-company RBAC, validated by Zod

```jsonc
{
  "companies": {
    "8eac2097-…": {
      // Paperclip companyId (or slug)
      "name": "GRAFMAKER",
      "groups": {
        "Sales": {
          "services": {
            "notion": { "actions": ["read"], "scopes": ["Sales", "General"] },
            "paperclip": { "actions": ["read", "create_ticket"], "scopes": ["sales"] },
          },
          "agents": ["sales-expert", "pricing-advisor"], // expert-agent access (by shortname)
          "workflows": ["register_contract"], // allowed routines (Capability B)
        },
        "General": {
          "services": { "notion": { "actions": ["read"], "scopes": ["General"] } },
          "agents": [],
          "workflows": [],
        },
      },
    },
  },
}
```

- **`services`** → company rights `(group, scope)`. **`agents`** → expert-agent access (Capability C), referenced **by shortname** (stable/readable; MCP resolves shortname→id via the Paperclip API), fail-closed (agent not listed ⇒ not exposed). **`workflows`** → allowed routines (Capability B).
- **Resolution**: for the requesting user, list companies where (user's JumpCloud groups ∩ company.groups) ≠ ∅. Effective permission/scope/agents per company = **union** across matching groups (already how `resolvePermissions` accumulates).
- **MCP becomes multi-company aware**: today it is pinned to one `PAPERCLIP_COMPANY_ID`. New model: tools resolve/accept a **company context**; the company-scoped Paperclip API (`/companies/{id}/...`) does the rest. Default to the user's single company when only one is accessible.
- **Tenant isolation** (internal ⇒ row-scoping by `company_id`): all reads/writes filtered by the resolved company set. **No cross-company leakage** even though the board API key can see everything — the MCP enforces the boundary.

### SOC 2 controls + evidence (CC6 Logical Access / Confidentiality)

- Least privilege, deny-by-default (already fail-closed). Access matrix is **version-controlled** (`rbac.json` in git → reviewable change history).
- **Cross-tenant isolation tests** in CI (automated negative tests: user of company A cannot read company B's data) — primary evidence for confidentiality.
- Quarterly **access review**: export `(user → groups → company access)` for sign-off (feeds Comp AI).
- Offboarding: removal from a JumpCloud group instantly removes access (verified by the group-resolution fix).

---

## 3. Capability B — Official processes = predefined triggerable workflows (Q2)

**Goal**: a company declares official processes, directly triggerable from the MCP, validated and traced.

### Design — back it by Paperclip **routines** (native)

- Each official process = a **Paperclip routine** (`routine create`), per company, with: name, description, parameter contract, target agent, and a **required RBAC scope/permission**.
- MCP exposes:
  - `henri_list_workflows` → lists routines available for the user's **company + scope** (filtered; unauthorized ones hidden).
  - `henri_start_workflow` (rewritten) → validates the workflow **exists in the company catalog**, the user is **authorized**, and parameters match the contract, then triggers via `routine run` / `trigger:fire`.
- This finally gives the `workflows` field in `rbac.json` a real purpose (today it is loaded but never enforced — placeholders only).
- **Human-in-the-loop**: sensitive processes (invoice, contract, payment) create an **approval-gated** ticket (Paperclip `approval` ops) — never auto-execute. Processing Integrity control.

### SOC 2 controls + evidence

- **Full traceability**: who triggered which process, when, with which parameters, and the outcome (EVT audit event + Paperclip routine run record). Immutable log.
- **Authorization enforced** per process (not free-text). Catalog is change-managed (routine revisions are versioned natively).

---

## 4. Capability C — Expert agents with authorized chat (Q3)

**Goal**: per-company "expert" agents available to _specific_ members, chat-style, **access explicitly authorized**.

### Design

- Expert agents = **Paperclip agents** (`agent create`) configured with domain **skills** (`skills:sync`), **instructions/knowledge** (`instructions-*`), and least-privilege **agent permissions** (`permissions:update`).
- **Authorization** via the per-company RBAC: add an `agents` grant to a group (the original CLAUDE.md RBAC already anticipated `agents: string[]`). Only authorized members see/use a given expert.
- **MCP exposes a chat tool only for authorized agents** — e.g. `henri_ask_expert(agentId, message)` whose agent list is restricted to the user's grants (unauthorized agents are not exposed, same fail-closed pattern as other tools).
- **Interaction model (async)**: Paperclip agents are task/heartbeat-driven; there is no synchronous chat endpoint. A "chat" = relay the member's message via `agent prompt`/`wake`, then read the agent's reply from the task session / issue thread. UX is near-real-time (wake) or short async round-trip. _(If true synchronous chat is required, that is a larger build — flag for decision.)_

### SOC 2 controls + evidence

- Explicit per-agent authorization = least privilege (CC6).
- **Every member↔agent interaction logged** (EVT + Paperclip task sessions) — who talked to which expert, when, content reference. Confidentiality + monitoring.
- **LLM data handling**: messages to expert agents go to the Anthropic API → ensure **DPA + zero-retention** with Anthropic (Confidentiality). Agent knowledge scoped per company (no cross-company knowledge bleed).

---

## 5. Cross-cutting SOC 2 controls (Security + Confidentiality)

| Control area            | Implementation                                                                                                                           | Evidence (for Comp AI)                                       |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Logical access (CC6)    | JumpCloud SSO + fail-closed RBAC + per-company least privilege                                                                           | `rbac.json` history, access reviews, JumpCloud group exports |
| Audit logging (CC7)     | EVT audit events on every tool call + agent interaction + routine run; CloudWatch; Sentry                                                | Log retention over the observation window, immutability      |
| Change management (CC8) | PR + CI gates + IaC; **segregation of duties** (author ≠ approver) + prod approval gate **to formalize**                                 | PR reviews, CI runs, deploy approvals                        |
| Confidentiality         | Tenant row-scoping + isolation tests; Notion/Paperclip scope filtering; data classification                                              | Cross-tenant negative tests, scope config                    |
| Encryption              | TLS in transit (`sslmode=require`); **verify RDS encryption-at-rest enabled**; secrets in AWS Secrets Manager                            | RDS config, KMS, secrets policy                              |
| Vendor mgmt             | Sub-processor register: AWS, Anthropic, Notion, JumpCloud, HubSpot, Hyperline, Pennylane, Comp AI                                        | Their SOC 2 reports + DPAs                                   |
| AI-specific             | Human-in-the-loop on sensitive actions; Anthropic DPA + zero-retention; Methods Officer self-modification gated by enforced CEO approval | Approval records, Anthropic terms                            |

### ⚠️ Items to formalize for the audit

1. **Segregation of duties** in change management: currently PRs are self-merged. SOC 2 wants independent review + an enforced **production approval gate**.
2. **RDS encryption-at-rest** — verify it is enabled (likely, but must be evidenced).
3. **Anthropic DPA + zero data retention** — confirm contractual terms.
4. **Comp AI connectors** for AWS / GitHub / Google Workspace / JumpCloud — confirm in catalog (580+ integrations advertised). If self-hosted, the Comp AI instance itself becomes in-scope infra to secure.

---

## 6. Phased plan

1. **Phase 0 — SOC 2 groundwork** (parallel, org): engage auditor, define observation window, stand up Comp AI, sub-processor register, policies.
2. **Phase 1 — Foundation (A)**: per-company RBAC config + multi-company MCP + **cross-tenant isolation tests in CI**. Formalize change-management segregation of duties.
3. **Phase 2 — Official processes (B)**: routine-backed workflow catalog + `henri_list_workflows` + validated `henri_start_workflow` + approval gates + traceability.
4. **Phase 3 — Expert agents (C)**: agent provisioning (skills/instructions), per-group agent authorization, authorized chat relay + interaction logging.

Each phase ships via the standard PR → CI → staging → production flow, with the SOC 2 evidence wired as it lands.

---

## 7. Open decisions for the CEO

- **Ticket scope source** (carried over): derive a ticket's scope from the **requester's department** vs the **workflow type**. Recommendation: requester now, workflow type once routines exist.
- **Expert chat UX**: accept **async** (recommended, native) vs invest in a synchronous experience (larger build).
- **Comp AI hosting**: managed (simpler, GRC tool not self-operated) vs self-hosted (free, but in-scope to secure).
- **Methods Officer self-modification**: confirm the CEO-approval gates must be **technically enforced** (not just documented) before any agent-authored change reaches `main`.
