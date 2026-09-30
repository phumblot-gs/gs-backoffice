# Audit delivery operations

## Deployment gate

PR #119 provisions the archive bucket, two SQS queues, a fourth Fargate service
(`audit-consumer`, 0.25 vCPU / 0.5 GiB, desired count 1), scoped IAM and alarms.
This adds continuously running compute and storage/queue costs. Rollouts stop the
old consumer before starting its replacement to avoid doubling the delivery rate.
Producer tasks share their existing role; the consumer has its own receive/delete
role and cannot read archived audit objects. Producer access to `audit/*` is write
only. No task may delete archived evidence.

Before accepting staging:

1. Confirm all four services stable and the consumer heartbeat is present.
2. Invoke a harmless read tool. Find its event ID in the producer audit log,
   `audit/<eventId>.json`, `AUDIT_DELIVERED`, and EVT's tenant-scoped evidence.
3. Exercise an approved, reversible sensitive action. Verify intent and outcome
   share an invocation ID, have different event IDs, and retain the human identity.
4. In an isolated test environment, simulate EVT timeout/503: confirm the producer
   can still deposit, the consumer pauses receiving, queue age rises, and the
   independent alert arrives. Restore EVT and observe gradual recovery.
5. Simulate failed S3/SQS writes in that isolated environment: a sensitive tool
   must not execute; a read may complete, with a deposit-failure alert.
6. Complete an agent run, roll its task, then read the historical run log through
   Paperclip to prove native S3 fallback. Do not assume unit mocks prove live IAM.

Do not inject outages by changing production credentials or shared access policy.
No live failure injection or deployment is performed by the local test suite.

## During an EVT incident

Inspect `/ecs/gs-backoffice-<environment>/audit-consumer` for
`AUDIT_CIRCUIT_OPEN` (status, event ID, next delay). Do not increase replicas or
restart repeatedly: restart resets the in-memory cooldown. The configured maximum
is one publish per second; sustained arrivals above that rate accumulate, even
when EVT is healthy. Assess volumes before changing the limit.

401/403 usually require credentials/permissions repair; 429 calls for respecting
downstream capacity. Timeouts/5xx indicate availability issues. No payloads or
credentials are printed by the consumer. `AUDIT_CONSUMER_FAILURE` may instead mean
an SQS/IAM fault. A DLQ event needs inspection and correction before selected replay.

An outage longer than 14 days can expire pending messages. S3 archives have no
automatic expiry, but recovery is **manual**, not guaranteed automatic catch-up.
Investigate the 24-hour alarm promptly. An intent archive with no outcome does not
prove execution; an intent deposited to S3 but rejected by SQS must not be treated
as an executed action. Replaying an audit fact never reruns the business tool.

## Selected-event recovery from S3

Use an operator identity with `s3:GetObject` on the exact archive and
`sqs:SendMessage` on the matching queue. Do not broaden the producer/consumer roles.
Select missing event IDs by comparing the incident's archived evidence with EVT
and consumer delivery records. Account for uncertain acknowledgements: delivery
can duplicate a bus event even when EVT database insertion is deduplicated.

After `pnpm install --frozen-lockfile` and `pnpm --filter @gs-backoffice/core build`,
set `AWS_REGION`, `AUDIT_ENVIRONMENT` (`staging` or `production`),
`AUDIT_ARCHIVE_BUCKET` and `AUDIT_QUEUE_URL` to Terraform's matching resources.
The script verifies naming and the event's environment; it never prints payloads.

```sh
node scripts/replay-audit.mjs <event-uuid>
# Review dry-run metadata, environment and existing EVT receipt first.
node scripts/replay-audit.mjs <event-uuid> --apply
```

Default is read-only. `--apply` enqueues one original envelope with the same ID and
timestamp; the normal consumer applies its delivery limit. For a larger recovery,
prepare a reviewed list of missing IDs and submit at a bounded rate. Do not blindly
replay the whole bucket or permanently invalid events. The script does not delete
DLQ entries: remove those only after confirming the corrected event's delivery.

## Existing operational cleanup

The unused Remote HTTP connection `7585ad15-a1db-41fa-867b-d34134bea175`
was removed with user approval. This did not remove the active Fly sandbox plugin.
Only the GRA-47 workspace session was archived; the other 26 remain pending
explicit approval. These changes are separate from deployment of the audit queue.
