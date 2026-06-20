# Methods Officer — Self-Evolution Loop (Paperclip-native)

> Status: **design / feasibility confirmed** (2026-06-20). Not yet built. Goal: a governed self-evolution loop — an evolution request is evaluated by a **Methods Officer**, who returns a **detailed plan including acceptance criteria**; the CEO validates it against a **criticality-based compliance registry**; **specialized sub-agents** implement; an **independent auditor (different LLM)** attests the work; the **requester** reviews & merges via Google Chat; the change is deployed to staging, a **staging cahier de recette** is run and **auditor-verified**; then the CEO records it in a **cross-project production-ready registry** from which evolutions are released to production. Constraint: stay as close as possible to the **Paperclip standard**.

## 1. Feasibility — yes, and it is native

Paperclip is a "virtual company" of agents that **plan, decompose, delegate, and execute code**. Every step maps to a native primitive (verified against the live staging Paperclip OpenAPI + API, `paperclipai@2026.609.0`):

| Need                                                  | Native Paperclip primitive                                                                                        |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Agent hierarchy (CEO → Methods Officer → specialists) | Agents with `role` + `reportsTo`                                                                                  |
| Specialized sub-agents                                | Roles `cto`, `engineer`, `security` (+ custom `title`)                                                            |
| Independent auditor on a **different LLM**            | A second agent on a different **adapter** (`codex_local`, `gemini_local`, `grok_local`) instead of `claude_local` |
| "Evaluate then plan" with acceptance criteria         | Issue `workMode: planning` → plan revisions; `acceptanceCriteria`                                                 |
| CEO validates the plan → spawn the work               | `POST /issues/{id}/accepted-plan-decompositions {acceptedPlanRevisionId, children[]}`                             |
| Sub-tasks assigned to specialists                     | `POST /issues/{id}/children` (`assigneeAgentId`, `acceptanceCriteria`, `blockParentUntilDone`)                    |
| Run code (impl, tests)                                | Adapter **`claude_local`** in an **environment**; **execution-workspaces**                                        |
| Work on a branch → PR                                 | `executionWorkspacePreference: operator_branch`                                                                   |
| Evidence (tests, audit, recette)                      | Issue **work-products** + **documents**                                                                           |
| Notify the requester / route gates to Chat            | EVT events + the **EVT→Google Chat consumer** (already live, with action buttons)                                 |
| CI / staging deploy → drive the next step             | GitHub Actions + Paperclip **public routine triggers** (`/routine-triggers/public/{id}/fire`)                     |
| Production-ready registry & per-evolution release     | Issues flagged "ready-for-production" (queryable) + a `deploy-to-production (...)` routine                        |

The Paperclip image ships `git` + `@anthropic-ai/claude-code`; installed adapters include `claude_local`, `codex_local`, `cursor`, `gemini_local`, `grok_local`, … The company has one agent (**CEO**) and one environment (**Local**, `driver: local`, default).

## 2. Agent organization

```
CEO (exists, role: ceo) — owns all human gates
 └── Methods Officer        role: cto       (feasibility, plan, acceptance criteria, recette)
      ├── Engineer          role: engineer  (implementation + unit/integration tests)
      ├── QA / Recette      role: engineer  (test execution + staging recette, per domain)
      └── Security Reviewer  role: security  (security review, pentest where required)
 └── Independent Auditor    role: security   adapter: grok_local (xAI)  (different LLM)
```

The **Auditor reports to the CEO, not the Methods Officer**, and runs on a **different LLM** (different adapter) so its judgment is independent of the team that produced the work. Roles are a fixed enum (`ceo|cto|cmo|cfo|security|engineer`); specialties via custom `title`, `permissions`, `budgetMonthlyCents`, instructions.

## 3. Compliance registry (criticality → standards)

Acceptance criteria are **derived from a registry**, not invented per request. The Methods Officer proposes a criticality; the CEO confirms/overrides it at Gate 1; the level mandates a fixed set of criteria.

| Criticality  | Examples                                        | Mandatory standards                                                                                         |
| ------------ | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **Low**      | docs, copy, internal tooling                    | unit tests on touched code; CI green; light audit                                                           |
| **Medium**   | new MCP tool, non-sensitive feature             | unit+integration ≥ 70% coverage on touched packages; CI green; auditor; staging recette                     |
| **High**     | RBAC / auth / data access / billing             | + mandatory security review + pentest of changed surface + performance budget (p95) + SOC 2 control mapping |
| **Critical** | infra/IaC, secrets, tenant isolation, prod data | + load test + human security sign-off + change-management evidence                                          |

- **Source of truth**: git-versioned `config/compliance-standards.json` (PR-reviewed → control changes are auditable), mirrored to a Notion database the Methods Officer maintains.
- **Machine-checkable wherever possible** (coverage %, p95 ms, pentest yes/no) so evidence is objective.

## 4. Lifecycle (mapped to the API)

1. **Evolution request** — an Issue is created (via `henri_start_workflow` on a `request-evolution (...)` routine), assigned to the **Methods Officer**, `workMode: planning`. The **requester's identity is carried on the issue** (needed at Gate 3).
2. **Feasibility + plan + acceptance criteria** — the Methods Officer produces a **plan revision**: sections _Architecture · Code · Secrets · Security · Performance & load · Documentation_, a proposed **criticality**, the **acceptance criteria** (from the registry), **and a staging cahier de recette** (steps + expected behavior). No code yet.
3. **Gate 1 — CEO validates the plan** → `accepted-plan-decompositions` spawns child issues to the specialists (`acceptanceCriteria`, `blockParentUntilDone`, `operator_branch`).
4. **Execution + evidence** — sub-agents implement on isolated branches (`claude_local`) and run the required tests (unit, integration, E2E, + load/pentest per criticality). Results are stored as **work-products on the issue** (durable, reviewable).
5. **Gate 2 — pre-PR authorization (CEO)** — before any PR exists, the CEO must see that (a) the **evidence exists** and **meets every acceptance criterion**; (b) the **independent Auditor** (different LLM) attests **all steps followed**, **criteria genuinely met**, and the **code is sincere** (no gamed/weakened/skipped tests, hardcoded expected values, disabled checks, back-doors, secrets, hidden scope); (c) the **cahier de recette** is delivered. Then the CEO authorizes **PR creation**.
6. **Pull request** — opened via git push + GitHub REST API (no `gh` in the image). `ci.yml` (lint/typecheck/test/build) runs as **independent re-verification on neutral infra**.
7. **Gate 3 — review & decide by the requester** — the notification is pushed to the **user who originated the request**, reusing the **Google Chat push + deep-link** mechanism built for the approval gate: a card carrying the test evidence + Auditor report + a **button to the PR**. The requester then either **merges** (branch protection: CI green + 1 review; the requester needs repo write access), or **rejects with a reason** — a motif + the corrections required — which **loops the issue back to the Methods Officer** (new plan revision / child issues), re-running the relevant gates before a new PR is proposed. The reason is recorded on the issue and emitted as an EVT event (audit + Chat). Agents never merge or deploy.
8. **Staging deploy + recette** — merge → existing `deploy-staging.yml`. The **cahier de recette** is executed against staging (see §8), results captured as work-products.
9. **Gate 4 — auditor-verified recette** — the **independent Auditor** verifies the recette tests actually ran on staging and **match the expected behavior** in the plan. If not, it **informs the CEO**, who asks the **Methods Officer for the necessary corrections** (the issue loops back to execution). Production stays blocked until the Auditor confirms.
10. **Record in the production-ready registry** — once the recette is auditor-verified, the CEO **records the evolution in the cross-project production-ready registry** (§7).
11. **Production release** — a `deploy-to-production (...)` routine releases a chosen ready evolution; the existing `deploy-production.yml` approval gate remains the final guard.

## 5. Human-in-the-loop gates (summary)

- **Gate 1 — plan + criticality + criteria** (CEO): no code before acceptance.
- **Gate 2 — pre-PR** (CEO): evidence meets all criteria + independent-LLM Auditor attests completeness & sincerity + cahier de recette delivered.
- **Gate 3 — review & decide** (the **requester**, via Google Chat push): CI green + review, with evidence + audit report in hand; **merge**, or **reject with a reason** that loops the issue back to the Methods Officer for corrections.
- **Gate 4 — auditor-verified recette** (CEO acts on Auditor's verdict): staging recette must match documented expected behavior; failure loops back to the Methods Officer.
- **Release** (CEO): record in the registry, then a controlled production deploy.

Cross-cutting: per-agent `permissions` + budgets; least-privilege GitHub credential (branch + PR, no admin); auditor on a different model; secrets never in code; every step emits EVT events (audit trail + Chat).

## 6. EVT events

The loop is wired through EVT events: each step emits one, the audit trail records every tool call, and the EVT→Google Chat consumer turns the human-facing ones into notifications. Two hard rules keep the bus clean (see [[reference_evt_queues]] for the queue contract):

**Convention — audit vs business.**

- **Audit events** are emitted automatically for every audited MCP tool call under a **single dedicated type** `backoffice.audit.tool_invoked` (core const `AUDIT_TOOL_INVOKED`), payload `{tool, category, input, isError, userEmail}` where `category` is the action (e.g. `knowledge.query`, `approval.decided`). They are **also always written to CloudWatch** (`audit_event` log line) independently of EVT (SOC 2 CC7 durable trail). They are NEVER published under a business type.
- **Business events** are published **explicitly** by the emitting plugin/agent under `backoffice.<domain>.<action>` types, with a rich, purpose-built payload.
- **Consumers subscribe by type** through a server-side-filtered EVT queue (the `notify-consumer` pattern), so audit noise never reaches a business consumer, and no event is missed regardless of the shared product-stream volume.

**Emitted today.**

| Event type                      | Kind     | Payload (key fields)                                                         | Emitter                                                       |
| ------------------------------- | -------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `backoffice.audit.tool_invoked` | audit    | `{tool, category, input, isError, userEmail}`                                | PluginManager, for any tool with an `auditCategory`           |
| `backoffice.approval.requested` | business | `{ticketId, processCode, scope, requestedBy, approveUrl}`                    | approval gate (`henri_start_workflow` on a sensitive process) |
| `backoffice.approval.decided`   | business | `{ticketId, processCode, scope, decision, approver, requestedBy, runTicket}` | approval gate (`henri_approve`)                               |

`actor` = `{userId, accountId, role}` and `scope` = `{accountId, resourceType, resourceId}` on every event. The `notify-consumer` queue (`backoffice-notify`) filters on the business types only.

**To add for the self-evolution loop** (business events, published explicitly; the notify-consumer subscribes to the human-facing ones and routes by `payload.scope`). `<id>` = evolution issue id; `scope` routes Chat to the requester/team.

| Event type                                                | Step / gate | Payload (key fields)                                             | → Chat                          |
| --------------------------------------------------------- | ----------- | ---------------------------------------------------------------- | ------------------------------- |
| `backoffice.evolution.requested`                          | 1 intake    | `{evolutionId, requestedBy, title}`                              | —                               |
| `backoffice.evolution.plan_ready`                         | 2 → Gate 1  | `{evolutionId, criticality, planRevisionId}`                     | CEO                             |
| `backoffice.evolution.plan_accepted` / `.plan_rejected`   | Gate 1      | `{evolutionId, decidedBy, reason?}`                              | requester                       |
| `backoffice.evolution.audit_completed`                    | Gate 2      | `{evolutionId, verdict, criteriaMet, sincere, reportUrl}`        | CEO                             |
| `backoffice.evolution.pr_ready`                           | Gate 3      | `{evolutionId, requestedBy, prUrl, evidenceUrl, auditReportUrl}` | requester                       |
| `backoffice.evolution.merged` / `.merge_rejected`         | Gate 3      | `{evolutionId, by, prUrl, reason?}`                              | requester + Methods Officer     |
| `backoffice.evolution.recette_passed` / `.recette_failed` | Gate 4      | `{evolutionId, verifiedBy, details}`                             | CEO (+ Methods Officer on fail) |
| `backoffice.evolution.ready_for_production`               | 10 registry | `{evolutionId, shortDescription, project}`                       | CEO                             |
| `backoffice.evolution.deployed`                           | 11 release  | `{evolutionId, project, includedEvolutionIds}`                   | requester + CEO                 |

New business types are added to `BACKOFFICE_EVENT_TYPES` in `packages/core`, to the notify-consumer's `SUBSCRIBED_EVENT_TYPES`, and to the `backoffice-notify` queue filter; rendering for each is added to the consumer's `renderMessage`.

## 7. Production-ready release registry & independent deployment

**Registry.** "Ready for production" = passed Gate 4. The CEO records the evolution; the registry is **cross-project** (all projects' ready evolutions in one place). Native modelling: the evolution issue is flagged **`ready-for-production`** (label/state) with a **short description**; the registry is the **query** over that flag across projects — listable via an MCP tool (`henri_list_releases`) and the Paperclip board.

**Per-evolution release routine.** A `deploy-to-production (...)` official process takes one ready evolution and triggers its production deployment, behind the existing `deploy-production.yml` approval gate. Listing + choosing + triggering one at a time is straightforward.

**Honest constraint on "independently of each other".** Our deploy model is trunk-based: `main` → `staging` branch → `production` branch deploys a **whole snapshot**, not a cherry-picked subset. So:

- **Across projects/repos**: naturally independent (separate pipelines) — full independence.
- **Within one repo**: evolutions merge to `main` in sequence. "Deploy evolution X" promotes `main` up to X's merge commit — you control **timing and order**, not an arbitrary subset (you can't ship a later evolution while holding back an earlier one it sits on top of).
- **For true per-evolution independence within a repo**: ship behind **feature flags** (merge + deploy dark; "deploy to production" = flip the flag). Powerful but heavier — propose only if the need is real.

**Chosen semantics (CEO, 2026-06-20)**: releasing evolution X promotes `main` up to X's merge commit, shipping **X plus every earlier merged evolution not yet in production** — the natural trunk-based, cumulative semantics. No feature flags needed: the registry tracks what is ready/not-yet-in-prod, and a release simply advances production to the chosen evolution's point (carrying along any earlier ready ones). The registry's listing therefore also shows, per evolution, whether it is already implied by a later release.

**Recommendation**: build the registry + per-evolution release routine now (record, list with short description, deploy by promoting to a chosen evolution — cumulatively). Reserve feature flags for the rare case where an evolution must be shipped out of merge order.

## 8. CI/CD integration & staging recette (answers A & B)

**A — CI integration.** The agent loop ends at "PR open"; the existing pipeline then drives, and Paperclip reacts around it:

- On the PR, `ci.yml` runs automatically → its green status is **independent evidence** for Gate 3 (agents test locally for Gate 2; CI re-runs on neutral infra so a faked local pass is caught).
- After the requester merges and `deploy-staging.yml` runs, a final CI step calls a **Paperclip public routine trigger** to start the **staging-recette routine** — the clean CI→Paperclip hand-off; deploy success/failure can be posted back to the issue.

**B — Agents executing the cahier de recette on staging.** Yes, and the recette (and thus the agent) differs by project nature:

- A **QA / Recette** agent runs the cahier, capabilities packaged as Paperclip **skills** per domain: _back office / MCP_ (call the MCP tools / API directly — what we did by hand for the approval gate); _web app_ (Playwright / computer-use); _infra_ (smoke scripts, `terraform plan`, probes).
- **Recommendation**: make the cahier **executable** wherever possible (scripted smoke suite vs staging, captured as a work-product — deterministic, hard to fake) and reserve the _agent_ for judgment steps (UX, visual, exploratory). The plan declares **which recette profile** applies.

## 9. Branch lifecycle (answer C)

Each evolution runs on its own `operator_branch`, disposable once its PR merges to `main`:

- Enable **"Automatically delete head branches"** → GitHub deletes the branch on merge, zero accumulation (history preserved in `main` + the merged PR).
- A lightweight **housekeeping routine** (Data-Officer-style heartbeat) deletes branches whose PR is closed/stale > N days, never touching `main`/`staging`/`production`.

## 10. Execution setup (the hands-on configuration)

- **Project bound to the repo** — a Paperclip _project_ for `gs-backoffice` with `executionWorkspacePolicy = operator_branch` (each task = isolated branch workspace).
- **Environment** — reuse **Local** (`driver: local`, on the Paperclip container; has `git` + `claude-code`). The repo must be cloneable + a **GitHub token** available for push + PR.
- **Adapters** — `claude_local` for the build team (`ANTHROPIC_API_KEY`); **`grok_local` (xAI)** for the Auditor → needs the xAI API key.
- **Agents** — Methods Officer / Engineer / QA / Security / Auditor with `adapterType`, `defaultEnvironmentId = Local`, `reportsTo`, instructions, `permissions`, budgets.
- **Compliance registry** — `config/compliance-standards.json` + Notion mirror.

## 11. Open questions / prerequisites

1. **GitHub credential(s) for the agents** (CEO): the token is used by the **agents** to push branches + open PRs (not for merging — see item 2). Fine-grained, scope contents (push) + pull requests only. **Multiple tokens are supported**: store them as a **JSON map keyed by repo/project** (same pattern as `GOOGLE_CHAT_WEBHOOKS`), so each project/agent identity can use its own credential — useful for per-repo least privilege and for attributing agent commits/PRs to distinct bot identities. A dedicated machine user or GitHub App is the cleaner long-term identity; a fine-grained PAT is fine to start. One token per repo is the default; gs-backoffice needs one to begin.
2. **Requester merges with their own GitHub account** (no token): the Gate-3 merge is performed by the human requester in their browser via the PR link — so they must have **repo write access** and count as the required reviewer under branch protection. The agent token is never used to merge.
3. **Auditor LLM**: **`grok_local` (xAI)** — provide the xAI API key.
4. **Repo availability + headroom** in the Local env (clones, Claude Code, test runs; load tests may need a separate runner).
5. **Test tooling**: load-test + pentest tooling runnable from the env (or delegated) for High/Critical.
6. **Registry mechanics**: confirm the issue flag/label + cross-project query; decide whether within-repo releases stay ordered or move to feature flags.
7. **Criticality registry content**: finalize levels + mandated standards with the CEO.

## 12. Phased build plan

- **Phase A — Proof of concept (de-risk execution)**: project bound to gs-backoffice + GitHub token + one **Methods Officer** (`claude_local`, operator_branch). Trivial task → branch → edit → push → **open a PR**. Validates the one uncertain piece end-to-end.
- **Phase B — Plan, criteria, decomposition, audit**: planning mode; structured plan + criticality + criteria from the registry; CEO accepts → child issues to Engineer/Security; evidence as work-products; **independent Auditor** (different adapter); Gate 2.
- **Phase C — Merge-by-requester + CI/CD + recette + housekeeping**: Chat push to the requester with a PR button (Gate 3); CI→Paperclip public trigger after staging deploy; QA/Recette agent + executable cahier; Gate 4 auditor-verified recette; auto-delete + stale-branch housekeeping.
- **Phase D — Release registry + intake**: production-ready registry (record/list/short description) + `deploy-to-production (...)` per-evolution routine; `request-evolution (...)` intake process; gate notifications to Chat.

## 13. Why this stays on the Paperclip standard

No bespoke orchestration engine: native agents + hierarchy, native planning / plan-acceptance / child-issue decomposition, native `claude_local` (+ a second native adapter for the auditor), native environments/workspaces, native git `operator_branch`, native work-products for evidence, native public triggers for the CI hand-off, native issues/labels for the release registry. Our only custom code is the _intake_ (an official process), the _compliance registry_ (config + Notion), the _executable recette suites_, the _release registry tool/routine_, and the _notifications_ (already built). The loop is an **assembly of Paperclip primitives**, not a parallel system.
