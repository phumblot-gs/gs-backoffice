# Audit trail & durability model (SOC 2)

How every action taken through Henri — by an employee **or** by an agent in the
self-development loop — is recorded, and **which store is authoritative for what**. This is
the SOC 2 evidence map (CC6 logical access, CC7 monitoring, change management).

Last updated: 2026-09-30, following a runtime durability check.

**Deployment caveat:** on 2026-09-30, staging still used local-only run logs on
ephemeral Fargate storage. Four historical run-log reads returned 404. The S3
configuration below must be deployed and verified before treating bridge logs as
a durable audit backstop. It cannot restore logs already lost with old tasks.

## 1. Four durable stores (defense in depth)

No single store is the sole source of truth. An action is typically recorded in several,
so a gap in one (e.g. EVT briefly unavailable) does not lose the trail.

| Store                                             | What it holds                                                                                                                                                                     | Durability                                                                           |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **EVT bus** (`backoffice.*` events)               | The primary, cross-system event stream (audit + lifecycle + business).                                                                                                            | Append stream, tenant-scoped by API key. **Emission is best-effort** (never throws). |
| **CloudWatch** — MCP `audit_event` log            | **Every employee tool call** (`henri_*`): the `PluginManager` writes `logger.info({audit}, 'audit_event')` for each invocation, **independent of EVT**.                           | Durable; the SOC 2 backstop for the employee surface (CC7).                          |
| **Bridge run-log** (`backoffice_audit` on stderr) | **Every agent/bridge tool call + evolution event**: `publishEvent` always writes the event to stderr → captured in the Paperclip run-log, **before** the best-effort EVT publish. | Local until S3 mirroring is deployed and verified; see the deployment caveat above.  |
| **Paperclip `activity_log`** (native)             | `approval.created/approved/rejected`, `budget.*` (threshold crossed / incident resolved), routine runs, issue status transitions.                                                 | Native, durable, independent of our code.                                            |

**Implication:** approval decisions and budget changes are recorded in **two or three** places
(EVT + CloudWatch/run-log + native `activity_log`); the weakest single link (EVT-only) is the
bridge events, now mitigated by the stderr run-log backstop.

## 2. Event taxonomy (`backoffice.*`)

Envelope (all events, via `createBackofficeEvent`): `eventType`, `timestamp` (action time,
client-stamped; EVT also records an ingestion time), `source{application,version,environment}`,
`actor{userId,accountId,role}`, `scope{accountId,resourceType,resourceId}`, `payload`. `eventId`
is assigned by EVT. Actor = the human's `userId`+`userEmail` for employee tools, or the
agent's uuid (`role:"agent"`) for bridge events.

| Event type                | Emitted by                                                                         | Key payload                                                                       | Durable in                                |
| ------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------- |
| `audit.tool_invoked`      | MCP server (every `henri_*`) **and** bridge (every sandbox/governance/review tool) | `{tool, category, ok/isError, userEmail \| agentId, runId, issueId, input}`       | EVT + CloudWatch (MCP) / run-log (bridge) |
| `approval.requested`      | MCP `henri_start_workflow` (sensitive)                                             | `{approvalId, processCode, scope, requestedBy, summary, projectName, approveUrl}` | EVT + native `activity_log`               |
| `approval.decided`        | MCP `henri_approve` / `henri_review_approval`                                      | `{approvalId, processCode, scope, decision, approver, requestedBy, runTicket}`    | EVT + native `activity_log`               |
| `evolution.plan_proposed` | MCP (request_evolution approval requested)                                         | `{approvalId, processCode, requestedBy, notes}`                                   | EVT                                       |
| `evolution.plan_accepted` | MCP (request_evolution approved)                                                   | `{approvalId, processCode, approver, requestedBy, runTicket}`                     | EVT                                       |
| `evolution.step_created`  | bridge `create_child_issue`                                                        | `{issueId, agentId, childId, childIdentifier, assigneeAgentId, title}`            | EVT + run-log                             |
| `evolution.pr_opened`     | bridge `open_pr`                                                                   | `{issueId, agentId, number, url, title}`                                          | EVT + run-log                             |
| `evolution.completed`     | bridge `report_progress` (done)                                                    | `{issueId, agentId, identifier}`                                                  | EVT + run-log                             |
| `evolution.escalated`     | bridge `report_progress` (blocked/in_review)                                       | `{issueId, agentId, status, identifier}`                                          | EVT + run-log                             |
| `evolution.merged`        | CI `promote-staging.yml` (evolution PR merged)                                     | `{prNumber, url, branch, mergedBy, sha}`                                          | EVT + GitHub                              |
| `deploy.completed`        | CI `deploy-staging.yml` (deploy success)                                           | `{environment, sha, ref, runId, actor}`                                           | EVT + GitHub Actions                      |
| `notify.google_chat`      | bridge (PR review), budget plugin (alerts), digest                                 | `{text, scope}` → routed to a Chat channel by the notify-consumer                 | EVT                                       |
| `budget.snapshot`         | budget plugin (daily cron)                                                         | per-scope consumption (company/agents/projects), cents, status, paused            | EVT (BI)                                  |

The **notify-consumer subscribes only** to `approval.requested`, `approval.decided`,
`notify.google_chat` → only those reach Google Chat. `audit.*`, `evolution.*`, `budget.snapshot`,
`deploy.*` are **audit/BI only** (no Chat noise).

## 3. The change-management chain (self-evolution)

For a `request_evolution` (the SOC 2 change-management story), the trail is continuous:

1. **Request** — `audit.tool_invoked{henri_start_workflow}` + `approval.requested` + `evolution.plan_proposed` (who requested, what).
2. **Decision** — `audit.tool_invoked{henri_review_approval/henri_approve}` (the **approver**, ≠ requester — separation of duties) + `approval.decided` + `evolution.plan_accepted`.
3. **Implementation** — `evolution.step_created` (each Engineer step) + `audit.tool_invoked` for every sandbox tool + `evolution.pr_opened` (the PR).
4. **Go-live** — `evolution.merged` (the **human who merged**) + `deploy.completed` (correlate by `sha`).

Who / what / when is captured at each step; the human approver and the human merger are
recorded by name.

## 4. Retrieving the trail (verification)

- **EVT** — `/v1/events/query` is unreliable on the shared stream; use a **durable filtered
  queue** (consume + ack), created with the **container's** EVT key (events are tenant-scoped
  by publishing key — see the EVT-tenant note). `scripts/verify-evolution-events.mjs` (ensure →
  trigger → drain; `peek` for non-destructive listing).
- **CloudWatch** — log group `/ecs/gs-backoffice-staging/mcp-server`, filter `audit_event`.
- **Bridge** — the agent's Paperclip run-log (`backoffice_audit` lines).
- **Paperclip** — `GET /api/companies/:id/approvals`, `…/budgets/overview`, and the native
  `activity_log`.

## 5. Known limitations

- **Best-effort EVT emission**: an EVT outage drops the EVT copy (the event is never retried).
  Mitigated by the CloudWatch (MCP) and run-log (bridge) backstops, and the native `activity_log`
  for approvals/budget/routines.
- **Run-log durability**: native Paperclip S3 mirroring copies completed logs and
  in-flight output every 60 seconds. Upload failures do not fail the agent run;
  a dedicated CloudWatch alarm reports them. Abrupt termination can lose the tail
  since the last successful mirror, and a storage outage can lose more.
  Current S3 objects have no automatic expiration; noncurrent snapshot versions
  expire after 30 days. Versioning is recovery protection, not immutable storage.
- **Shared task role**: the three ECS services currently share a task role, so
  the new bucket permissions also apply to MCP and notify tasks. Object access is
  limited to `run-logs/*`; the role cannot delete logs. Role separation is not
  implemented by this change.
- **Merge/deploy** events come from CI (`source.application = gs-backoffice-ci`); if a deploy is
  done manually outside the workflow, no `deploy.completed` is emitted.
- See `multi-tenant-soc2-design.md` for the broader SOC 2 control map.
