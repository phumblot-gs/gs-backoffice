# Agent instructions

One folder per agent slug of `config/agents-authz.json`, each with an `AGENTS.md` entry
file. They are reviewed like code (CODEOWNERS) and baked into the Paperclip image at
`/opt/gs-agent-tools/agent-instructions/<slug>/`, owned by root: agents can read them,
never rewrite them.

## Why not Paperclip's managed bundles

A `managed` bundle lives under `/paperclip/instances/…` on the container's local disk,
which Fargate wipes on every deploy. On 2026-11-06 the CEO's and the Engineer's
instructions were gone (`ENOENT`), and the Methods Officer had none. Paperclip's default
templates also tell agents to call the API with `curl` and read `PAPERCLIP_TASK_ID` from
the environment; with no shell on the host, that produced `printenv` attempts.

## Pointing an agent at its file (one time per agent and environment)

Paperclip 2026.824.1 supports `external` bundles: an absolute root path it reads without
copying. When the folder already holds files, Paperclip writes nothing to it.

```http
PATCH /api/agents/{agentId}/instructions-bundle
{ "mode": "external", "rootPath": "/opt/gs-agent-tools/agent-instructions/<slug>", "entryFile": "AGENTS.md" }
```

Run it from inside the Paperclip container (ECS Exec, loopback, the container's own key),
like the other staging operations. Afterwards a change to an instructions file only
needs a merge and a deploy.
