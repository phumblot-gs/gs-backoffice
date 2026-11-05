# Paperclip operational recovery — 2026-09-30

## 1. Failing tool connection (unused connection retired)

Connection: `7585ad15-a1db-41fa-867b-d34134bea175`.
The native health sweep reported 670 failures over the inspected seven days.
The sweep logs only IDs; its detailed failure is stored in the connection's
`healthStatus` and `healthMessage` and native tool audit events.

The authenticated board identified **Fly Sprites Sandbox Provider**, configured
as Remote HTTP with no address: `Remote MCP connection requires config.url`.
It was installed on no agents and all three action permissions were Off. The
generic UI banner incorrectly suggested a broken key; the technical error was
missing configuration, not evidence of a revoked Sprites token.

Pausing failed with the same validation error. With the owner's explicit
approval, the unused connection was removed through the native board action on
September 30. The UI confirmed `App removed`. This retires an unused integration;
it does not make that connection operational. The Apps experimental navigation
was enabled to expose its settings and remains visible for maintenance.

The separate **Fly Sprites Sandbox Tools** plugin remains `ready`, verified after
removal. Henri's bridge invokes `/api/plugins/tools/execute` directly, rather
than this remote-MCP connection. Native health sweeps only select active, enabled
connections, so the archived connection is excluded from subsequent sweeps.

The new tool-connection alarm detects two failing sweeps within an hour and uses
the existing SNS/Google Chat alarm route. It does not diagnose or repair the
connection. No healthy-service claim should be based on infrastructure alarms alone.

## 2. Native run-log persistence

The deployed task had no volumes or `RUN_LOG_S3_*` configuration. Paperclip
2026.824.1 supports native S3 mirroring in `services/run-log-store.js`:

- local files serve live reads;
- finalized logs are copied to S3;
- `RUN_LOG_S3_INFLIGHT_MIRROR_SECONDS=60` also copies active output;
- missing local files fall back to S3 reads, including byte ranges;
- failed uploads emit `[run-log-store] Failed to mirror...` warnings.

Terraform enables this feature with a private, encrypted, versioned bucket in
the environment's AWS region. The normal ECS task credential chain authenticates
to AWS. No new access key or Paperclip patch is needed. Object access is limited
to `run-logs/*`; the existing shared task role also serves MCP and notify tasks.
Current logs are retained indefinitely; noncurrent snapshot versions expire
after 30 days. No automatic object deletion permission is granted to the app.

### Validation before deployment

Use Terraform 1.9.8 to validate staging and production. Do not run a live plan
that reads secret values when those reads have not been authorized.

Extract the official `@paperclipai/server@2026.824.1` package, then run:

```sh
node --experimental-vm-modules scripts/verify-paperclip-run-log-store.mjs /path/to/package/dist
```

The test loads unmodified native source and substitutes its external dependencies.
It verifies finalized-log fallback after local deletion, range reads, in-flight
shutdown flushing, and an observable upload failure with the local log preserved.
S3 is in memory: this does not prove deployed IAM permissions or actual AWS writes.

### Validation after deployment

1. Confirm the task has the five `RUN_LOG_S3_*` settings and both new alarms exist.
2. Complete an authorized, harmless agent run. Confirm a matching `.ndjson`
   object exists under `run-logs/` in the dedicated bucket using object metadata.
3. Read that run's log in the board before and after the next controlled task
   replacement. Confirm it remains available without mirror warnings.
4. Confirm the connection health checks separately; successful S3 persistence
   does not prove tool availability.

Do not replace the task just to test this while useful runs are active. A deploy
also destroys any pre-existing local-only logs; the new configuration does not
backfill them. Existing missing logs cannot be recovered from an RDS backup
because RDS stores their references, not the local log files.

## 3. Workspaces skipped by terminal cleanup

The sweep repeatedly inspected 27 candidates with `skippedUndelivered=27`.
This counter includes failed Git inspection, dirty files, and delivery state not
proven merged. It does not establish that all 27 are safe to archive.

Inspect each workspace's native close preview, linked issue tree, repository,
branch/head, local path, and linked pull-request work product. Confirm the PR
is merged and corresponds to that workspace's exact work before closing it.
The native delivery check requires matching branch and head SHA; a missing local
checkout can prevent this proof even if a PR was merged.

Never set all candidates to delivered or delete their records to silence the
sweep. Missing delivery evidence, retained work, and stale empty workspaces need
different remedies.

The board lists 11 gs-backoffice, eight poc-sandbox, and eight Onboarding sessions.
GRA-47's preview confirmed a shared session with an absent local directory, no
branch or repository, a completed linked task, and only `Archive workspace record`
as its cleanup action. Its native archive succeeded (HTTP 200); the active list
dropped to ten gs-backoffice sessions and its retained configuration disables the
Close action. No underlying project files were removed. GRA-42 has the same
preview conditions; the remaining 26 sessions await authorized per-preview cleanup.
