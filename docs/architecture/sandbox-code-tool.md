# Sandbox Code Tool — running Claude in a Fly Sprite as a _tool_, not an _environment_

> Status: **design (2026-06-21). Not yet built.** Goal: let a Methods Officer agent delegate a coding task to **Claude running inside an isolated, reusable Fly Sprite microVM**, have the result **pushed to GitHub from inside the sandbox**, then **regain control** to review the diff (via GitHub tools), iterate, and **re-invoke Claude in the same sandbox** — all without depending on Paperclip's sandbox _environment_ machinery. The capability is packaged as a **self-contained plugin tool** so it stays isolated and is cleanly removable if/when Paperclip ships native E2B support that matches this need.

## 1. Why a tool, not an environment driver

We first integrated Fly Sprites as a Paperclip **sandbox environment driver** (`packages/sandbox-fly-sprites`). That makes the _agent run itself_ execute "on" the sandbox, which drags in Paperclip's whole remote-workspace machinery — and every layer of that machinery fought the immature `@fly/sprites` 0.0.1 transport. The root realisation: **we don't want the agent to run in the sandbox; we want the agent to _send a task to_ the sandbox.** Modelling the sandbox as a **tool** the agent calls (agent stays on Local) sidesteps the entire problem class.

| Problem hit with the environment-driver approach                     | Cause                                                                                       | Status with the tool approach                                                             |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| stdin not forwarded → `claude` never got its prompt → `process_lost` | SDK `execFile` can't send stdin                                                             | reused fix (spawn + StdinEOF) — see [#55]                                                 |
| workspace restore tar corrupted → `adapter_failed`                   | SDK exec WS truncates >64 KB stdout                                                         | reused fix (redirect + length-verified chunked read) — see [#56]                          |
| `process_lost` mid-run                                               | redirect silences the WS → Paperclip's liveness watchdog kills the in-sandbox agent process | **gone** — the agent runs on Local; nothing watches a process _inside_ the Sprite         |
| retry fell back to Local                                             | recovery re-resolves the env                                                                | **moot** — no Paperclip sandbox _run_ happens (env-driver patch [#57] no longer triggers) |
| orphaned Sprite kept running                                         | Paperclip's bridge daemon not killed + `reuseLease` never deletes                           | **we own the lifecycle** in the tool                                                      |
| no git-native workspace                                              | sync strategy hard-coded by driver in Paperclip 2026.609.0                                  | **bypassed** — git clone/push happens inside the Sprite, Paperclip never syncs files      |

What carries over: the **reliable Sprite transport** we built and validated ([#55] stdin, [#56] chunked exec) and the `@fly/sprites` client wiring move from the env driver into the tool. What becomes unused: the **environment driver** itself and the Paperclip retry-env patch ([#57]) — to be retired once the tool replaces it.

## 2. The shape of it

The agent that runs the loop executes normally (Local, `claude_local`). It calls one tool to offload a coding task to a sandbox, gets a structured result, then uses its **GitHub tools** to inspect the actual diff/PR and decide what to do next.

```
Methods Officer / sub-agent (runs on Local)
        │
        │  tool call: sandbox_code_task({ sandboxKey, repo, baseBranch, targetBranch, task })
        ▼
  ┌───────────────────────────── plugin tool (runs in the Paperclip worker) ─────────────────────────────┐
  │  1. resolve Sprite for `sandboxKey`  → create (git clone) | reuse (git fetch + checkout)              │
  │  2. inject GitHub token + ANTHROPIC_API_KEY for the duration of the exec only                          │
  │  3. run `claude -p "<task>" --output-format json` inside the Sprite (reliable transport)               │
  │  4. claude edits → commit → push `targetBranch`                                                         │
  │  5. capture { branch, headSha, pushed, prUrl?, summary, costUsd } and return it                        │
  └────────────────────────────────────────────────────────────────────────────────────────────────────┘
        │  result
        ▼
Methods Officer / sub-agent  → reviews the diff via GitHub MCP tools (compare/PR files)
        │
        ├─ satisfied → open/finish PR, hand to the governance gate
        └─ needs changes → call sandbox_code_task again with the SAME `sandboxKey`
                           (same Sprite, woken from cold; `git pull`; claude iterates)
```

The Sprite is **stateful and reusable across calls**: the agent and the sandbox have a conversation across multiple tool invocations, which is exactly the "invoke → review → re-invoke in the same sandbox" loop.

## 3. Tool contract (draft)

`sandbox_code_task` — input:

| Field             | Meaning                                                                                                                                                                                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sandboxKey`      | Stable id scoping Sprite reuse. Must be tied to the **repo** (e.g. `proj-<projectId>`, since each project has its own repo) so a reused Sprite always matches its clone. Same key → same Sprite.                                                               |
| `repoUrl`         | Git URL to clone on first use. **Resolved per project** — it varies from one project to another and may even change over time for the same project; never hard-coded. The caller (the engineer sub-agent / Methods Officer) passes the current project's repo. |
| `baseBranch`      | Branch to start from (default repo default).                                                                                                                                                                                                                   |
| `targetBranch`    | Branch the agent's work is committed/pushed to.                                                                                                                                                                                                                |
| `task`            | The instruction handed to `claude -p` inside the Sprite.                                                                                                                                                                                                       |
| `model` (opt)     | Claude model for the in-sandbox run.                                                                                                                                                                                                                           |
| `timeoutMs` (opt) | Hard cap for the in-sandbox run.                                                                                                                                                                                                                               |

Output (structured):

| Field                           | Meaning                                              |
| ------------------------------- | ---------------------------------------------------- |
| `sandboxKey`, `spriteName`      | Which sandbox handled it (for traceability + reuse). |
| `branch`, `headSha`, `pushed`   | What landed on GitHub.                               |
| `prUrl` (opt)                   | If the tool also opens/updates a PR.                 |
| `summary`                       | Claude's own synthesis of what it did.               |
| `result`, `costUsd`, `exitCode` | Raw outcome + telemetry.                             |
| `logRef` (opt)                  | Pointer to the full in-sandbox transcript for audit. |

The tool is **idempotent-ish per call** (each call is one bounded Claude turn that ends by pushing). Long-running concerns (a turn that exceeds `timeoutMs`) end the call with a partial result rather than hanging.

## 4. Sprite lifecycle (the cold/cheap reuse model)

Fly Sprites auto-hibernate: `running → warm → cold` when idle; an exec wakes a cold Sprite; the disk persists; a cold (stopped) Sprite bills storage only, not CPU/RAM. So the intended model is **provision once, reuse warm/cold**:

- **First call for a `sandboxKey`**: create the Sprite, `git clone` the (per-project) `repoUrl`, (optionally) provision toolchain (e.g. `pnpm` — missing from the base image; install once).
- **Subsequent calls (same key)**: the Sprite is cold (≈ free) → exec wakes it → `git fetch` + checkout/reset → `claude` iterates → push. No re-clone; fast.
- **Repo-match guard**: because `repoUrl` is per-project and can change, on reuse the tool verifies the Sprite's existing clone `origin` matches the call's `repoUrl`. On mismatch (wrong/changed repo) it re-clones fresh (or provisions a new Sprite) rather than fetching the wrong repository. Keying `sandboxKey` to the project keeps this an edge case (repo URL changed for the project), not the norm.
- **Isolation**: distinct `sandboxKey`s ⇒ distinct Sprites ⇒ **concurrent tasks/tickets never share a sandbox**. This is the per-ticket isolation requirement, made explicit and owned by the tool (vs Paperclip's `reuse_by_environment` which shared one Sprite per environment).
- **Cleanup**: a TTL / explicit `sandbox_release(sandboxKey)` tool deletes the Sprite (and kills any process in it). A periodic reaper deletes Sprites idle beyond a retention window, so nothing lingers (the orphaned-bridge class of bug cannot recur, because there is no bridge daemon — we never start one).

Checkpoints (`createCheckpoint`/`restoreCheckpoint` in the SDK) are an optional optimisation: snapshot a freshly-cloned+provisioned Sprite and restore it to spin up sibling sandboxes instantly. Out of scope for the spike.

## 5. Secure GitHub credentials

The sandbox needs a credential to `git push`. The tool injects it **per exec, in the command environment only** (never written to a persistent file in the Sprite, never baked in the image, never logged). Sourcing options, cheapest first: a **fine-grained PAT** scoped to the target repo (read/write contents + PRs), stored in AWS Secrets Manager and read by the worker; later, a **GitHub App** installation token minted per task (short-lived, least-privilege, auditable) — preferred for production. The credential lives in the Paperclip worker (the tool), is handed to the Sprite for the single push, and is not retained. This is the same "secure git cred" item deferred during the PoC, now scoped narrowly to one tool.

## 6. Governance fit (Methods Officer loop)

This tool is the **execution primitive** under the existing self-evolution design ([methods-officer-self-evolution.md](./methods-officer-self-evolution.md)). Mapping:

- A specialist sub-agent (engineer) is assigned an implementation issue. Instead of running `claude_local` on a sandbox environment, it **calls `sandbox_code_task`** with the issue's repo/branch/task.
- The push produces a branch/PR — the **artifact the governance gates already expect** (requester review via Google Chat, independent auditor on a different LLM, staging recette).
- The sub-agent **reviews the diff with GitHub tools**, iterates by re-calling the tool, and when satisfied emits the work-product + routes to the merge gate.
- The independent auditor can **read the same PR diff** (GitHub tools) — no dependency on Paperclip's workspace sync to inspect the work.

The Methods Officer governance (criticality registry, acceptance criteria, gates, production-ready registry) is unchanged; only the _implementation step_ swaps "run agent in sandbox env" for "agent calls the sandbox tool."

## 7. Risks / open questions

- **In-sandbox `claude` reliability over the SDK WS**: the agent run that streamed (GRA-15) completed; our reliable chunked transport ([#56]) handles bulk reads. A single bounded `claude -p` turn that pushes is far less demanding than Paperclip's full run+restore, so the `process_lost` watchdog issue does not apply (no external watcher). Still to validate end-to-end in the spike.
- **`claude` auth/config inside the Sprite**: confirmed working with `ANTHROPIC_API_KEY` passed via env (probe: `result: "PONG"`); the base image already ships the `claude` CLI.
- **Toolchain in the image** (`pnpm`, project deps): provision-on-first-use, or bake a custom Sprite image / checkpoint. Decide in the spike.
- **Cost guardrails**: per-call `timeoutMs`, a max-concurrent-Sprites cap, and the idle reaper.
- **Plugin tool execution limits**: confirm a Paperclip plugin tool can run for the minutes a real coding task takes (and stream/return a large summary) — the worker uses native WebSocket (Node 22), which behaved better than the polyfill in tests.

## 8. Build plan

1. **Spike** (throwaway public repo, disposable PAT): a minimal `sandbox_code_task` tool — create Sprite → clone → `claude -p` "touch a file + commit + push" → return the branch. Prove the loop end-to-end (push lands on GitHub, agent can re-invoke same Sprite).
2. **Lifecycle**: `sandboxKey` reuse (warm/cold), `sandbox_release`, idle reaper, concurrency cap.
3. **Secure creds**: PAT from Secrets Manager (spike) → GitHub App token (production).
4. **Integrate** into the Methods Officer loop (engineer sub-agent calls the tool; auditor reviews via GitHub tools).
5. **Retire** the sandbox _environment driver_ and the Paperclip retry-env patch ([#57]) once the tool supersedes them; keep the reliable-transport helpers ([#55]/[#56]) in the tool.

[#55]: stdin forwarding fix (merged)
[#56]: reliable large-output exec (merged)
[#57]: Paperclip retry-env patch (merged; to retire)
