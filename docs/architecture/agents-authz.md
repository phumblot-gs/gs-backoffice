# Agent authorizations as code

Last updated: 2026-11-05. Applies to Paperclip **2026.824.1** (staging and production);
the [upgrade section](#d-prepare-the-paperclip-20268241--202610230-upgrade) covers 2026.1023.0.

## Why

Human access is already governed in Git: `config/rbac.json` maps JumpCloud groups to
services and scopes, is validated in CI and changes only through a reviewed PR. Agents need
the same discipline. Paperclip has **no deny layer** for grants and **no instance-wide
switch** to constrain agents (`PAPERCLIP_SETTING_DEFAULTS` / `PAPERCLIP_HIDDEN_SETTINGS`
only set UI defaults), and recent releases ship permissive defaults (full-auto harnesses,
default grants, hiring by default). Paperclip therefore cannot enforce our policy on its
own: **Git is the source of truth, and we detect drift from it.** Phase 1 is read-only:
nothing in this design writes to Paperclip.

| Piece                  | Where                                                                             |
| ---------------------- | --------------------------------------------------------------------------------- |
| Policy file            | `config/agents-authz.json`                                                        |
| Schema + loader        | `packages/core/src/agents-authz.ts` (Zod, strict, fail-closed)                    |
| CI rules               | `packages/core/src/agents-authz-rules.ts`, run by `scripts/check-agents-authz.ts` |
| Approval mapping table | `packages/core/src/agents-authz-mapping.ts`                                       |
| Drift comparison       | `packages/core/src/agents-authz-drift.ts` (pure, no client)                       |
| Drift job              | `packages/authz-drift-plugin` (Paperclip plugin, read capabilities only)          |
| Change event           | `.github/workflows/agents-authz-changed.yml`                                      |
| Ownership              | `.github/CODEOWNERS`                                                              |

## The file

One file, common definitions, explicit per-environment sections — one PR, no divergence.

```text
version            1
company            requireBoardApprovalForNewAgents (must be true)
instance           runnerApiToolsEnabled (must be false), experimentalFlagsOff[]
profiles           name → { trustPreset, runsIn, approvalMode }
agents             slug → { profile, canCreateAgents, canCreateSkills, canAssignTasks,
                            grants[{key, scope?}], connectors{action → {state, externalSend}},
                            adapter{type, model?, allowedTools?, plainEnvAllowed?}, trustBoundary?,
                            hiringException?{justification, approvedBy[], approvedAt},
                            owner, justification, reviewedAt }
environments       staging | production → { companyId?, agentIds{slug → uuid}, overrides{slug → partial agent} }
```

- **Hiring exception.** `canCreateAgents=true` is allowed only with an explicit `hiringException` (justification, who approved it, when). It is allowed only while `requireBoardApprovalForNewAgents` is on, so every hire the agent proposes still needs a board decision. It can never come from an environment override. `agents:create` as a grant stays forbidden. Today only the CEO holds one (decided by Pierre on 2026-11-05).
- **Identity.** Agents are keyed by a stable slug. Paperclip UUIDs are mapped per
  environment and are **read from Paperclip, never guessed**. An override may change any
  agent field except `owner`, `justification` and `reviewedAt`.
- **`runsIn`** is where the agent's _harness_ runs. `host` = inside the Paperclip container.
  Our Engineer and Methods Officer run on the host and only _call_ the Fly Sprites sandbox
  tools; the code runs in the sandbox, the harness does not.
- **`approvalMode`** is abstract (`restricted` | `read_only` | `full_auto`). It is translated
  per adapter by a tested table, so adapter flags never appear in agent entries:

  | approvalMode | `claude_local` (verified)                                       | other adapters             |
  | ------------ | --------------------------------------------------------------- | -------------------------- |
  | `restricted` | `dangerouslySkipPermissions=false`, no bypass flag in extraArgs | `unverifiable` (see below) |
  | `read_only`  | same flag; read-only is enforced by `adapter.allowedTools`      | `unverifiable`             |
  | `full_auto`  | `dangerouslySkipPermissions=true` (sandbox-only, rule-enforced) | `unverifiable`             |

  An **unset** `dangerouslySkipPermissions` is judged by Paperclip's default, `true`, so it
  is drift for a restricted agent. Paperclip 2026.824.1 has no ACPX adapter, and neither
  its OpenAPI spec nor its shared types define an approval key for `codex_local` /
  `opencode_local` (`approvalPolicy`, `permissionMode` and `acpxPermissionMode` appear
  nowhere). Those rows are `null` and report `unverifiable` until filled from a running instance.

- **Grant `scope`** is opaque: the OpenAPI spec types it as `object, additionalProperties: {}`
  and documents no selector syntax (`scope.allow` appears nowhere). It is stored verbatim
  and compared structurally. Do not invent selectors.
- **Secrets never belong here.** CI rejects credential-looking strings in the file.
- **Agent env.** Every `adapterConfig.env` entry must be a secret reference (`secret_ref` / `user_secret_ref`). A plaintext value is stored in the database and its backups, and `GET /api/agents` returns it unmasked. Non-secret identifiers may stay plaintext only if they are listed in `adapter.plainEnvAllowed`; today that is the Methods Officer's `PAPERCLIP_PROJECT_ID`.

## CI rules (hard failures)

Evaluated on the **effective** agent of **both** environments, so an override cannot sneak
a forbidden setting past review. Each rule has a negative fixture in
`packages/core/src/__fixtures__/agents-authz/`.

| Rule                       | Fails when                                                                                                                                                                              | Fixture                                                                                     |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `no-hiring`                | `canCreateAgents=true` without an explicit `hiringException`; any `agents:create` grant; a `hiringException` while board approval of hires is off. An override cannot add an exception. | `business-can-hire`, `business-hiring-grant`, `override-sneaks-hiring`, `hiring-exception*` |
| `host-not-full-auto`       | a profile with `runsIn: host` and `approvalMode: full_auto`                                                                                                                             | `business-full-auto`                                                                        |
| `low-trust-sandbox`        | `low_trust_review` with `runsIn ≠ sandbox`                                                                                                                                              | `low-trust-on-host`                                                                         |
| `low-trust-boundary`       | `low_trust_review` without `rootIssueId` / `projectIds` / `issueIds`                                                                                                                    | `low-trust-without-scope`                                                                   |
| `external-send`            | an external-send action is `allowed`, or a send-like action is not flagged `externalSend`                                                                                               | `business-sends-without-approval`, `send-not-flagged`                                       |
| `board-approval-for-hires` | `company.requireBoardApprovalForNewAgents ≠ true`                                                                                                                                       | `hires-without-board-approval`                                                              |
| `unique-agent-id`          | one Paperclip id mapped to two slugs in an environment                                                                                                                                  | `duplicate-agent-id`                                                                        |
| `review-date`              | `reviewedAt` older than **120 days** (warning from 100), or in the future                                                                                                               | `stale-review`                                                                              |
| `runner-api-tools-off`     | `instance.runnerApiToolsEnabled=true`, or any Terraform file sets `PAPERCLIP_RUNNER_API_TOOLS_ENABLED=true`                                                                             | test                                                                                        |
| `no-plaintext-secret-env`  | a credential-like name (`KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `PRIVATE`…) is listed in `adapter.plainEnvAllowed`                                                                        | test                                                                                        |
| schema                     | missing `owner` / `justification` / `reviewedAt`, unknown permission key, unknown field                                                                                                 | `missing-owner`, `unknown-permission-key`                                                   |

The 120-day limit fails **every** CI run once any agent is overdue. That is deliberate: it
is the quarterly access review, and it cannot be skipped silently.

## Drift detection

A Paperclip plugin (`gs-backoffice.authz-drift`) runs `authz-drift-check` daily at
05:00 UTC; a board user can also run it on demand from the plugin's jobs page. Its manifest
requests only `jobs.schedule`, `companies.read`, `agents.read`,
`authorization.grants.read` and `secrets.read-ref`, so **the host itself refuses any
write**. It does not request `agent.tools.register`, so the env-passthrough patch does not
apply: the EVT key comes from a secret reference in the plugin config.

For every company whose plugin config names an `environment`, it loads the baked
`/opt/gs-agent-tools/agents-authz.json` (fail-closed) and compares:

| Observed by the plugin (2026.824.1)                                                                                                                                    | Reported as `unverifiable`, never `ok`                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| company `requireBoardApprovalForNewAgents`                                                                                                                             | connector action states: no plugin capability exposes tool connections                              |
| agents present / missing / unknown (terminated agents are ignored)                                                                                                     | `runsIn`: environment drivers are not readable by plugins                                           |
| `permissions.canCreateAgents`, `canCreateSkills`, `trustPreset`, `authorizationPolicy.trustBoundary`                                                                   | `canAssignTasks`, unless an explicit `tasks:assign` grant or the `ceo` role makes it observable     |
| explicit grants (`authorization.grants.list`, principal type `agent`)                                                                                                  | `PAPERCLIP_RUNNER_API_TOOLS_ENABLED`: the worker env is curated (enforced statically in CI instead) |
| `adapterType`, `model`, `dangerouslySkipPermissions`, `--allowedTools`, bypass flags in `extraArgs`, **names** of plaintext `adapterConfig.env` entries (never values) | instance experimental flags: instance settings are not readable by plugins                          |
| approval mode of an adapter without a verified mapping                                                                                                                 |                                                                                                     |

**Outputs.** One `backoffice.authz.drift` event per non-`ok` finding, with payload
`environment, status, agentSlug, agentId, path, expected, actual, reason, trigger`. Statuses:
`drift`, `unknown_agent`, `missing_agent`, `unverifiable`. When there is anything other
than `unverifiable`, the job also sends one Google Chat message (`scope: leadership`) and
logs a `BACKOFFICE_JOB_FAILURE` line, so the existing CloudWatch alarm fires even when EVT
is down. A missing or invalid file, or an unreadable Paperclip, is a failure with the same
two alerts, never a pass.

**Secret hygiene.** The collector carries allow-listed fields only. It never reads
`adapterConfig.env`, never carries raw `extraArgs` (only the parsed `--allowedTools` list
and the known bypass sequences), and every reported value goes through a credential
scrubber. A test plants a key in `adapterConfig.env`, in a drifted field, in `extraArgs`
and in a grant scope, then asserts it appears in no event and no log.

**Production.** `environments.production.agentIds` is empty, because there was no production
access in this change. Until a reviewed PR fills it in from production Paperclip, a
production run reports every agent as `missing_agent` and every live agent as
`unknown_agent`. That is a loud failure by design.

## Change process

1. Anyone, including the Methods Officer through the self-evolution loop, may open a PR
   that changes `config/agents-authz.json`. **Agents never approve or merge.**
2. CI must pass, including the `Agents authz policy` step.
3. A **code owner who is not the author** approves. Pierre authors → Denis approves; the
   bot or Denis authors → Pierre or Denis approves. Agents are not code owners, so an agent
   approval never counts.
4. A human merges. `agents-authz-changed.yml` emits `backoffice.authz.changed` (SHA, PR,
   author, merger, approvers, changed slugs, environments). The file ships in the Paperclip
   image, so the change is live at the next deploy (`backoffice.deploy.completed`, same SHA).
5. **Paperclip is then aligned by hand** by an Owner. This phase never writes to Paperclip,
   and the next drift run confirms the alignment.

### GitHub settings to apply manually

Repository → Settings → Branches → branch protection rule for `main`:

- [x] Require a pull request before merging
  - Required approvals: **1**
  - [x] Dismiss stale pull request approvals when new commits are pushed
  - [x] Require review from Code Owners
  - [x] Require approval of the most recent reviewable push (no self-approval of your own last push)
- [x] Require status checks to pass before merging: `Lint`, `Typecheck`, `Test`, `Build`
      (the policy check runs inside `Lint`)
  - [x] Require branches to be up to date before merging
- [x] Do not allow bypassing the above settings (applies to administrators too)
- [ ] Allow force pushes: **off**. [ ] Allow deletions: **off**.

Also:

- Make sure Denis (`@denis-gs`) is a collaborator with **Write** access. Code owners on a
  personal-account repository must have write access, or GitHub ignores their CODEOWNERS entry.
- Do **not** give the GitHub App (`grafmaker-henri[bot]`) or any agent token the right to
  approve: the App needs `pull_requests: write` to open PRs. Its approvals would not count
  anyway, because it is not a code owner.
- GitHub does not natively require two _specific_ people. We chose "one code owner, not the
  author" (2026-11-05) as sufficient for separation of duties. If two-person approval is
  ever required, add a required status check that verifies both approvals.

## Staging inventory — 2026-11-05 (read-only, sanitized)

Collected over loopback inside the staging Paperclip task (ECS Exec, `GET` only, board key
from the container env, never printed). Credential values were redacted inside the
container before output. Company id and member identities are omitted.

**Instance:** Paperclip 2026.824.1, `authenticated` / `public`.
`PAPERCLIP_RUNNER_API_TOOLS_ENABLED`: unset (off). `PAPERCLIP_SETTING_DEFAULTS` /
`PAPERCLIP_HIDDEN_SETTINGS`: unset. Default environment: **Local** (`local` driver). A
second environment, **Fly Sprites (EU)**, uses the `sandbox` driver; it is bound to no agent.
Experimental flags on: `enableEnvironments`, `enableIsolatedWorkspaces`, `enableApps`,
`enableWorkspaceBranchReconcileForward`, `enableWorkspaceDirtyQuarantineRepair`.
`enablePublicMcp`, `enableGitHubReviewBots` and `enableMcpAggregators` **do not exist** in
2026.824.1.

**Company:** `requireBoardApprovalForNewAgents = false`. Tool connections: 1, archived
(Fly Sprites provider, removed 2026-09-30). Tool policies: 0. Tool profiles: 0. Members:
2 humans, both Owner (two accounts of the CEO); **no agent principal holds an explicit grant**.

| Agent (slug)                        | id          | role     | adapter        | model      | trust preset     | canCreateAgents | canCreateSkills | dangerouslySkipPermissions | `--allowedTools`                           | runs in |
| ----------------------------------- | ----------- | -------- | -------------- | ---------- | ---------------- | --------------- | --------------- | -------------------------- | ------------------------------------------ | ------- |
| CEO (`ceo`)                         | `80096853…` | ceo      | `claude_local` | Haiku 4.5  | unset (standard) | **true**        | true            | **true**                   | none                                       | host    |
| Methods Officer (`methods-officer`) | `e9ef031e…` | cto      | `claude_local` | Sonnet 4.6 | unset (standard) | false           | true            | false                      | 13 tools (read-only + `gs-sandbox` bridge) | host    |
| Engineer (`engineer`)               | `cf4d5caf…` | engineer | `claude_local` | Haiku 4.5  | unset (standard) | false           | true            | false                      | 11 tools (read-only + `gs-sandbox` bridge) | host    |

`canAssignTasks` is not returned by `GET /api/agents/:id` in 2026.824.1 (see below).
Connector action states: no connection is installed on any agent. The six business agents
described in `CLAUDE.md` (Chief of Staff, Data Officer, Finance, HR, Sales Ops) **do not
exist in Paperclip**. They are not listed in the file, and they will be added by PR when
created.

**Aligned on staging on 2026-11-05** (Pierre's decision, applied through ECS Exec and read back; no other field changed):

- `company.requireBoardApprovalForNewAgents`: false → **true**
- `ceo` `adapterConfig.dangerouslySkipPermissions`: true → **false**
- `ceo` `canCreateAgents` stays **true**, now declared through a `hiringException`.

**Expected drift on the first staging run:**

| Finding                                 | Decision needed                                             |
| --------------------------------------- | ----------------------------------------------------------- |
| `canCreateSkills`: true → false (all 3) | Confirm none of the agents needs to create or import skills |

Production has not been touched: apply the same two changes there, then fill in its agent ids.

**CEO plaintext key — removed on staging on 2026-11-05.** The CEO agent's `adapterConfig.env`
held its own `ANTHROPIC_API_KEY` in plaintext, returned unmasked by `GET /api/agents`. It was
removed through ECS Exec with `replaceAdapterConfig` and read back: env is now empty and no
other field changed. The CEO now uses the container key, like the other agents. That key was
**different** from the container key, and none of the 3 config revisions holds it. It remains
in RDS backups, so **revoke it** in the Anthropic console: it is the key last used around
2026-06-21 (the CEO's last run). Nothing else uses it. Production has not been checked. The
drift job now reports any plaintext env value by name.

## Where the docs and the real API disagree (2026.824.1)

| Expected (task brief / docs)                                                           | Reality                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Company setting `requireBoardApprovalForHires`                                         | `requireBoardApprovalForNewAgents` (company object)                                                                                                                                                                     |
| `trustBoundary` alongside `trustPreset`                                                | `permissions.authorizationPolicy.trustBoundary`, strict, with required `mode: "low_trust_review"`; `trustPreset` at `permissions.trustPreset` or `authorizationPolicy.trustPreset`                                      |
| `canAssignTasks` is an agent switch                                                    | Writable via `PATCH /api/agents/{id}/permissions`, but the read side is derived (`access.taskAssignSource`: `simple_default`, `explicit_grant`, `agent_creator`, `ceo_role`) and **absent** from `GET /api/agents/{id}` |
| ~21 permission keys                                                                    | Exactly 21 (OpenAPI enum), including `audit:view_agent_actions` and `pipelines:write`                                                                                                                                   |
| `scope.allow` syntax for tool grants                                                   | Not in the spec: `scope` is `object, additionalProperties: {}, nullable`                                                                                                                                                |
| ACPX `permissionMode` / `acpxPermissionMode`, Codex `approvalPolicy`                   | Not present in 2026.824.1 (no ACPX adapter; no approval key in spec or shared types)                                                                                                                                    |
| Claude `dangerouslySkipPermissions` per agent                                          | Confirmed: `adapterConfig.dangerouslySkipPermissions`, set via `PATCH /api/agents/{id}`                                                                                                                                 |
| Experimental flags `enablePublicMcp`, `enableGitHubReviewBots`, `enableMcpAggregators` | Do not exist in 2026.824.1 (presumably later releases)                                                                                                                                                                  |
| Connector actions `Allowed` / `Ask first` / `Off`                                      | Confirmed as `allowed` / `ask_first` / `off` (`ToolConnectionTestDecision`), but not readable by plugins                                                                                                                |
| Agent grants visible per agent                                                         | Not in `GET /api/agents/{id}` nor in `/members` (humans only); readable through the plugin SDK `authorization.grants.list`                                                                                              |

## Runbook

### a) Add an agent

1. Create the agent in Paperclip staging with the target settings: hiring off, an explicit
   restrictive approval mode, an explicit model, and an explicit `--allowedTools` for `claude_local`.
2. Read its UUID from the board URL or `GET /api/companies/{id}/agents`.
3. PR: add `agents.<slug>` (profile, switches, grants, connectors, adapter, owner,
   justification, `reviewedAt` = today) and `environments.staging.agentIds.<slug>`.
4. After merge and deploy, run the drift job on demand: expect no actionable finding.
5. Repeat for production: create the agent, then a PR adding `environments.production.agentIds.<slug>`.

Between steps 1 and 4 the drift job reports the agent as `unknown_agent`. That is
expected, and it is the alert that catches a hire made without a PR.

### b) Change a grant or a switch

PR first, Paperclip second: change the file, get code-owner approval, merge, then apply
the same change in Paperclip and confirm with an on-demand drift run. A change made in
Paperclip first shows up as drift until the PR lands, and that is intended.

### c) Respond to a drift alert

1. Read the `backoffice.authz.drift` events or the chat message: environment, agent, path,
   expected, actual.
2. `unknown_agent`: who created it? (Paperclip activity log.) Pause it unless a PR is open.
3. `drift`: if the change was not reviewed, revert it in Paperclip (an Owner, by hand). If it
   was intended, open the PR that makes the file say so.
4. `missing_agent`: an agent was deleted or the id mapping is wrong; fix it by PR.
5. `unverifiable`: not an incident. It lists what Paperclip does not let us observe; review
   those fields by hand during the quarterly access review.
6. A `BACKOFFICE_JOB_FAILURE` from the job means it could not evaluate (file invalid,
   Paperclip unreadable, plugin not configured): the state is **unknown**, so treat it as an alert.

### d) Prepare the Paperclip 2026.824.1 → 2026.1023.0 upgrade

Explicit restrictive modes set **before** 2026.1001 are preserved; unset ones silently
become full-auto. Hence:

1. **Set explicit values first, on 824.1:** `dangerouslySkipPermissions=false` on every
   restricted `claude_local` agent (the CEO was explicitly `true` and was set to `false` on
   staging on 2026-11-05; production still needs it). Set an explicit model on every agent: since 2026.916, unset Claude models
   resolve to Opus 5. Switch `requireBoardApprovalForNewAgents` on, because since 2026.916
   new standard agents can hire by default. Run the drift job and **get it clean except
   `unverifiable`** before going further.
2. **Snapshot the database** (RDS manual snapshot) and record the image digest.
3. **Drain all old processes** before any ≥ 2026.1012 build starts: stop every running agent
   run and let the old task stop fully, because 2026.1012 enforces stored tool grants as
   written and a malformed `scope.allow` now denies.
4. **Staging first.** Upgrade, then run the drift job on demand. Then fill in the mapping
   rows that become verifiable (ACPX `permissionMode`, Codex `approvalPolicy`) from the real
   adapterConfig keys, and add the new experimental flags to `experimentalFlagsOff`. Review
   agents created by default with ~14 configuration grants (2026.1012), and the Operator role
   growing from 1 to 14 grants (2026.1023): invites default to Operator. Note that budgets
   now block unpriced usage by default, and that `enableNativeRunner` defaults on for
   self-hosted instances (2026.916); neither is observable by the job yet.
5. Production only after a clean staging drift run, following the same steps.

## Enabling the job (human steps, after merge and deploy)

1. Board → Plugins → install from local path `/opt/gs-plugins/plugin-authz-drift`.
2. Configure it on the company: `environment` (`staging`), `evtApiUrl`, `evtAccountId`, and
   `evtApiKey` as a secret reference. `chatScope` defaults to `leadership`.
3. Run `authz-drift-check` on demand and compare with the expected first-run drift above.
4. Decide the findings (table above), align Paperclip by hand, run again.
5. Leave the daily schedule on. Follow-up: an alarm on "no drift run for 26 h", because the
   auditor runs inside the system it audits, and disabling the plugin would silence it.
