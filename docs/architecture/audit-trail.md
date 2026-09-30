# Audit trail and durability model

Last updated: 2026-09-30. **The S3 mirror and asynchronous delivery described below
are PR #119 changes, pending deployment and live verification.** Historical run
logs already lost with old Fargate tasks cannot be recovered by this change.

## Stores and responsibilities

| Store                     | Evidence                                                        | Retention / limits                                                                                                                                                                       |
| ------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S3 `run-logs/`            | Native Paperclip agent execution logs, including bridge stderr  | Current objects have no automatic expiry; old snapshot versions expire after 30 days. Native mirror every 60 seconds and at completion; abrupt termination can lose the unmirrored tail. |
| S3 `audit/`               | Structured audit envelopes, written before SQS enqueue          | No automatic expiry, including old versions. Versioning is recovery protection, **not immutable storage**.                                                                               |
| Dedicated SQS audit queue | Pending delivery to EVT                                         | 14 days; single consumer, bounded recovery throughput.                                                                                                                                   |
| EVT                       | Cross-system audit and business events                          | Delivery of queued events is asynchronous and at least once.                                                                                                                             |
| CloudWatch                | Employee `audit_event`, delivery signals and operational errors | Retention configured by Terraform; consumer logs retained 30 days.                                                                                                                       |
| Paperclip PostgreSQL      | Native activity log, approvals, budgets, issue/run state        | Separate native evidence; database backup policy applies.                                                                                                                                |

Detailed execution logs stay in S3. Structured audit facts are delivered to EVT;
raw log files and raw MCP tool arguments are not copied into the audit queue.
Agent events carry `runId` / `issueId`; employee events identify the user and tool.

## Delivery and outage behavior

```text
Employee MCP / agent bridge
  -> S3 audit/<eventId>.json
  -> dedicated SQS queue
  -> audit-consumer (one request at a time, at most one EVT publish/second)
  -> EVT
```

The deposit has a shared three-second deadline for S3 and SQS, without application
retries. A failed deposit attempts an independent CloudWatch metric with at most
another 500 ms. Operations do not wait for EVT **to record the queued audit**.
Other business integrations and notification calls retain their own latency.

On timeout, network failure, HTTP 401/403/429 or server error, the consumer leaves
the message pending, changes its visibility and stops receiving during an
exponential cooldown: approximately 30 seconds, 60 seconds, etc., capped at 15
minutes with jitter. The consumer also uses an eight-second EVT request timeout,
including response-body reads. There is no nested EVT client retry. It resumes
at the same bounded rate after recovery; it does not drain the backlog in a burst.
Cooldown state is in memory and resets on a consumer restart.

Invalid envelopes and HTTP 400/413/422 responses go to a separate failed-event
queue. The original message is deleted only after that transfer succeeds. There
is deliberately no automatic `maxReceiveCount` redrive: an EVT outage must not
exhaust delivery attempts for valid events. Both queues retain messages 14 days;
S3 provides recovery evidence beyond this window, subject to operator replay.

## Sensitive tool execution

In staging and production, `AUDIT_QUEUE_REQUIRED=true` enables mandatory durable
auditing. For mutating or unknown tools:

1. Record an **intent** with actor, tool, timestamp and `invocationId`.
2. Require successful S3 archival **and** SQS enqueue before invoking the tool.
3. Execute the tool, retaining existing RBAC and human-approval gates.
4. Record an **outcome** (`success`, `error`, or `exception`) with the same
   invocation ID and a distinct event ID.

An intent is not proof that the action completed. A crash between these steps may
leave an unmatched intent. An outcome-deposit failure raises an operational
signal but does not report an already executed action as cancelled. Investigate
before retrying an action with external side effects.

Explicit read-only tools can run when the audit deposit fails; the failure is
still signalled. New tools default to the sensitive gate. Local development
without any audit queue configuration retains the legacy direct-EVT path.

## Coverage and event taxonomy

All authorized tool executions registered by the employee `PluginManager`, and
all tools wrapped by the agent bridge, emit `backoffice.audit.tool_invoked` through
the new path. Schema/RBAC rejection before invocation is outside this wrapper.

The bridge also queues its `backoffice.evolution.*` facts (step created, PR opened,
completed, escalated). Business notifications (`backoffice.notify.google_chat`)
stay on the existing direct EVT route. Employee approval/evolution business
events, budget-plugin events, CI merge/deploy events and other Paperclip native
operations are **not all migrated to this queue**. Their existing evidence stores
and delivery behavior still apply. In particular, an EVT outage can still delay
or lose a best-effort notification even while its tool audit is safely queued.

Useful correlation fields are `eventId`, `payload.invocationId`, actor, timestamp,
tool, run/issue IDs, PR number and commit SHA (where the originating event includes
them). Structured tool audit records contain input **key names**, not values.
Lifecycle events may contain titles/summaries; access to evidence remains restricted.

## Duplicate delivery and ordering

The same event ID is preserved in S3, SQS retries and recovery. The inspected EVT
code deduplicates database inserts by `event_id`, but publishes to SNS before the
insert: **bus subscribers can still receive duplicates** and must deduplicate by
ID before causing side effects. End-to-end exactly-once delivery is not promised.
The SQS queue is standard, so consumers must correlate phases by invocation ID
and action timestamp rather than assuming arrival order.

## Alerts and recovery

Alerts use CloudWatch -> SNS -> the existing Google Chat alert Lambda, independent
of EVT. They cover failed deposits, open circuit, consumer errors, missing process
heartbeat, oldest pending event >5 minutes, backlog >=10,000, failed-event queue,
and oldest pending event >24 hours (well before retention expiry).

A process heartbeat proves liveness, not successful delivery. SQS age/backlog and
`AUDIT_DELIVERED` / `AUDIT_CIRCUIT_RECOVERED` establish progress.

See [audit delivery operations](../operations/audit-delivery.md) for deployment
checks, outage handling and selected-event recovery. See
[multi-tenant SOC 2 design](multi-tenant-soc2-design.md) for the broader control map.
This implementation does not wire Comp AI or itself establish SOC 2 compliance.
