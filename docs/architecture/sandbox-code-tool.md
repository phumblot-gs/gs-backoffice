# Sandbox Tools — running commands (and Claude) in a Fly Sprite as _tools_, not an _environment_

> Status: **design (2026-06-21, revised). Not yet built.** Goal: give the governance agents an isolated, reusable **Fly Sprite microVM** they can drive as **tools** — the general primitive is `sandbox_run` (execute any command in the sandbox at a given git ref and capture the result); `sandbox_code_task` is sugar on top for the engineer agent (run Claude → edit → commit → **push from inside the sandbox**). The same primitive lets **verification agents** (the independent auditor, acceptance-criteria controllers) run scanners, pentest tools and functional tests — in their **own** sandbox checked out at the pushed commit, for trustworthy, independent verification. All without depending on Paperclip's sandbox _environment_ machinery. Packaged as a **self-contained plugin** so it stays isolated and is cleanly removable if/when Paperclip ships native E2B that matches this need.

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

Agents run normally (Local, `claude_local`) and call the sandbox **tools** to offload work to an isolated microVM: the engineer offloads a **coding task** (`sandbox_code_task`); verification agents offload **scans/tests** (`sandbox_run`). Each gets a structured result and uses its **GitHub tools** to inspect the diff/PR. The diagram below shows the engineer's code-iteration loop; verification is the same primitive (`sandbox_run`) in a separate sandbox at the pushed commit (see §4, §6).

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

## 3. Tools (draft)

The capability is a small family of tools over one shared Sprite lifecycle. **`sandbox_run` is the primitive**; everything else is built on it.

### 3a. `sandbox_run` — the primitive (any command)

Execute an arbitrary command in a sandbox checked out at a given git ref, and return the result. This is what **verification agents** use: code scanners (`semgrep`, `trivy`), pentest tools, functional tests (`pnpm test`), lint, build — anything.

Input: `sandboxKey`, `repoUrl`, `ref` (branch or commit SHA to check out), `command`, `timeoutMs` (opt), `credMode` (opt: `read_only` default | `push`), `artifacts` (opt: paths to capture back, e.g. a SARIF report). Output: `{ sandboxKey, spriteName, ref, exitCode, stdout, stderr, artifacts?, durationMs }`. Large outputs/reports are captured via the reliable chunked transport ([#56]); big files are read back from the sandbox rather than streamed.

`sandbox_code_task` is then **sugar**: `sandbox_run` with `command = claude -p "<task>"` (+ `acceptEdits`) followed by `git add/commit/push` — i.e. the same primitive plus the git wrapper and a parsed Claude result.

### 3b. `sandbox_code_task` — engineer convenience (Claude edits + pushes)

Input:

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
- **Isolation by key/role**: distinct `sandboxKey`s ⇒ distinct Sprites ⇒ **concurrent tasks/tickets never share a sandbox**. The key is scoped by **role/intent**, not just by project: the engineer iterates in e.g. `eng-<issue>`, while a **verification agent uses its own** e.g. `audit-<issue>`. This is the per-ticket isolation requirement, made explicit and owned by the tool (vs Paperclip's `reuse_by_environment` which shared one Sprite per environment).
- **Verifier independence (integrity)**: an auditor / acceptance-criteria controller must NOT run in the engineer's working sandbox (which may hold uncommitted or arranged state). It opens its **own fresh sandbox checked out at the exact pushed commit/branch** and runs its scans/tests against **what is in git** — with **read-only** credentials (`credMode: read_only`, clone only, no push). Independent sandbox + least-privilege creds = trustworthy verification.
- **Cleanup (destroy)**: `deleteSprite` is **permanent** (Sprite + disk gone). It is **safe** — the durable artifact is the GitHub push; the Sprite is a disposable cache, recreatable at any commit. Triggered two ways: (1) **`sandbox_release(sandboxKey)`** explicitly when the work is terminal (PR merged / issue closed / verification done) — the primary teardown; (2) a **periodic idle reaper** as a backstop, deleting Sprites idle (no exec) beyond a **7-day default TTL (configurable)**. 7 days comfortably survives a multi-day human review/merge gate while reclaiming abandoned sandboxes; healthy flows release explicitly so the reaper rarely fires. (The orphaned-running-Sprite bug cannot recur: there is no bridge daemon — we never start one.)
- **No artifact trimming**: we deliberately do **not** clean builds/`node_modules`/test outputs before parking a Sprite cold (kept simple — the gain is marginal since destroy loses no work). Cold storage cost is bounded by destroy-on-terminal + the reaper; toolchain lives in the image/checkpoint, not the per-sandbox disk.

Checkpoints (`createCheckpoint`/`restoreCheckpoint` in the SDK) are an optional optimisation: snapshot a freshly-cloned+provisioned Sprite and restore it to spin up sibling sandboxes instantly. Out of scope for the spike.

## 5. Secure GitHub credentials

Git credentials are injected **per exec, in the command environment only** (never written to a persistent file in the Sprite, never baked in the image, never logged), via a credential helper that reads the token from the env. Credentials are **scoped by usage** (`credMode`): `sandbox_code_task` (engineer) gets a **push-capable** token; `sandbox_run` for verification gets a **read-only** token (clone only) — least privilege per role. Sourcing, cheapest first: a **fine-grained PAT** in AWS Secrets Manager (push: contents+PR write; verify: contents read); later, a **GitHub App** installation token minted per task (short-lived, least-privilege, auditable) — preferred for production. The credential lives in the Paperclip worker, is handed to the Sprite for the single operation, and is not retained. This is the "secure git cred" item deferred during the PoC, now scoped narrowly per tool + per role.

## 6. Governance fit (Methods Officer loop)

This tool is the **execution primitive** under the existing self-evolution design ([methods-officer-self-evolution.md](./methods-officer-self-evolution.md)). Mapping:

- **Engineer** sub-agent: assigned an implementation issue, it **calls `sandbox_code_task`** (repo/branch/task), iterates by re-calling with the same `sandboxKey`, reviews its own diff via GitHub tools, and pushes a branch/PR — the **artifact the gates already expect**.
- **Acceptance-criteria controller / independent auditor** (different LLM): the **acceptance criteria become concrete commands** run via **`sandbox_run`** — `pnpm test`, `semgrep`, `trivy`, a functional/pentest suite — in its **own fresh sandbox at the pushed commit** (read-only creds). The exit codes + captured reports become **work-products (evidence)** attached to the issue, which the merge gate and the requester review. The auditor can also **read the diff via GitHub tools** — two independent angles, neither trusting the engineer's sandbox.
- Verification runs are **reproducible and isolated**: same commit + same command in a clean microVM → a result the gate can trust.

The Methods Officer governance (criticality registry, acceptance criteria, gates, production-ready registry) is unchanged; the _implementation step_ becomes "engineer calls `sandbox_code_task`", and **acceptance verification becomes "controllers call `sandbox_run`"** — both on the same isolated-sandbox primitive.

## 7. Risks / open questions

- **In-sandbox `claude` reliability over the SDK WS**: the agent run that streamed (GRA-15) completed; our reliable chunked transport ([#56]) handles bulk reads. A single bounded `claude -p` turn that pushes is far less demanding than Paperclip's full run+restore, so the `process_lost` watchdog issue does not apply (no external watcher). Still to validate end-to-end in the spike.
- **`claude` auth/config inside the Sprite**: confirmed working with `ANTHROPIC_API_KEY` passed via env (probe: `result: "PONG"`); the base image already ships the `claude` CLI.
- **Toolchain in the image** (`pnpm`, project deps): provision-on-first-use, or bake a custom Sprite image / checkpoint. Decide in the spike.
- **Cost guardrails**: per-call `timeoutMs`, a max-concurrent-Sprites cap, and the idle reaper.
- **Plugin tool execution limits**: confirm a Paperclip plugin tool can run for the minutes a real coding task takes (and stream/return a large summary) — the worker uses native WebSocket (Node 22), which behaved better than the polyfill in tests.

## 8. Build plan

0. **Spike — DONE (2026-06-21).** Standalone prototype validated end-to-end on `paperclip-poc`: create/reuse Sprite (cold→warm) → clone → `claude -p` (acceptEdits) edits → commit + **push from the sandbox** → re-invoke same Sprite → continue the branch → append → push. Verified on GitHub (two commits on `spike/sandbox-tool`). Git auth via credential helper, no token leak.
1. **`sandbox_run` primitive** as a Paperclip **plugin tool** (the general command exec at a git ref, `credMode`, artifact capture), reusing the reliable transport ([#55]/[#56]). Then **`sandbox_code_task`** as sugar (claude + git push) and **`sandbox_release`**.
2. **Lifecycle**: per-role `sandboxKey` reuse (warm/cold), `sandbox_release`, idle reaper, concurrency cap.
3. **Secure creds**: PAT from Secrets Manager, **scoped by `credMode`** (push vs read-only) → GitHub App token (production).
4. **Toolchain provisioning**: install what tasks/verifiers need (`pnpm`, scanners like `semgrep`/`trivy`, test deps) on first use, via a custom Sprite image, or a checkpoint of a tooled Sprite.
5. **Integrate** into the Methods Officer loop: engineer calls `sandbox_code_task`; acceptance/auditor controllers call `sandbox_run` (own sandbox at the pushed commit, read-only) and attach results as work-products.
6. **Retire** the sandbox _environment driver_ and the Paperclip retry-env patch ([#57]) once the tools supersede them; keep the reliable-transport helpers ([#55]/[#56]).

[#55]: stdin forwarding fix (merged)
[#56]: reliable large-output exec (merged)
[#57]: Paperclip retry-env patch (merged; to retire)
