# Keyless Anthropic authentication (workload identity federation)

Last updated: 2026-11-06. Decision (Pierre, 2026-11-06): **option C**: Anthropic workload
identity federation on our **existing** Anthropic organization, with AWS STS outbound web
identity tokens as the identity provider. We considered and rejected the alternatives:
Claude Platform on AWS (separate organization, no EU inference pinning) and Bedrock EU.

## Why

A static `ANTHROPIC_API_KEY` lives in the app secret, in every Paperclip container
environment, and, until now, inside every Fly sandbox where model-generated code runs.
A leaked key is valid until someone notices and rotates it. With federation:

- **no long-lived Anthropic credential** exists in the Paperclip container;
- the **sandbox** receives a token that expires in at most 30 minutes, minted for a
  separate service account;
- access is bound to **one IAM role**, and revoked by changing an IAM policy or the
  Anthropic rule, with no key rotation.

Inference geography does not change: requests go to the same first-party API as today.

## How it works

```text
ECS task role  (gs-backoffice-<env>-paperclip-task, dedicated to Paperclip)
  │  sts:GetWebIdentityToken  (regional STS, RS256 — enforced by the IAM policy,
  │                            per audience: anthropic-agents ≤ 300 s, anthropic-sandbox ≤ 900 s)
  ▼
refresher (packages/anthropic-federation, started by the entrypoint)
  ├─ every 3 min: 5-min JWT (aud=anthropic-agents) → /run/anthropic/identity.jwt (0600)
  │      └─ Claude Code (claude_local agents) reads ANTHROPIC_IDENTITY_TOKEN_FILE and
  │         exchanges it itself → agents rule → service account "agents"
  └─ when < 20 min left: fresh 900-s JWT (aud=anthropic-sandbox) → POST /v1/oauth/token
         (sandbox rule) → 30-min access token → /run/anthropic/sandbox-token (0600)
             └─ Fly Sprites plugin → in-sandbox `claude` gets ANTHROPIC_AUTH_TOKEN only
```

| Piece                                                  | Where                                                                                              |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Dedicated task role, identity-token policy, env wiring | `infrastructure/terraform/modules/compute/anthropic-federation.tf`                                 |
| Mode switch                                            | `anthropic_auth = "api_key" \| "federation"` per environment (`environments/*/main.tf`)            |
| Refresher                                              | `packages/anthropic-federation`, baked at `/opt/gs-agent-tools/anthropic-federation/refresher.mjs` |
| Startup / supervision                                  | `docker/paperclip-entrypoint.sh` (initial pass before Paperclip starts, then a restart loop)       |
| Sandbox credential                                     | `packages/sandbox-fly-sprites/src/anthropic-credential.ts`                                         |

Design points:

- **Dedicated Paperclip task role.** The federation rules trust the JWT `sub`, which is the
  role ARN. The MCP server and the notify consumer keep the shared role, so they can never
  obtain an Anthropic token. The new role carries exactly the same application policies
  (secrets, run logs, audit producer) through `for_each`, and `moved` blocks keep the
  shared role's policies in place.
- **`check_jti` disabled on the federation issuer** (decided 2026-11-06). `check_jti` is
  an **issuer** field, not a rule field, so it covers both rules. Several concurrent
  `claude` processes read the same JWT file, and each exchange after the first would be
  refused as `jti_reused`. The compensating controls: a 5-minute JWT, an IAM-enforced
  audience, a single role ARN, a single workspace, and a file readable
  only by the `node` user.
  For the sandbox, replay protection adds little: its JWT is minted on demand, presented
  once, never leaves the Paperclip container, is bound to `anthropic-sandbox` and to one
  role, and lives 15 minutes at most.
- **Access-token lifetime is capped at 2 × the JWT's remaining lifetime.** Anthropic
  issues `min(rule lifetime, 2 × remaining JWT lifetime)`. Agents use 300 s JWTs, so their
  tokens last up to about 10 minutes, and Claude Code re-exchanges. The sandbox needs 30
  minutes, so its JWT is 900 s. The IAM policy enforces each maximum per audience.
- **OAuth scope is `workspace:developer`**, because the Console does not offer
  `workspace:inference` (2026-11-06). That is equivalent to the current API key. Narrow it
  to `workspace:inference` when it becomes available: only the rule ids would change.
- **No silent fallback.** In federation mode, Terraform does not inject the key and the
  entrypoint unsets any that is present (it would shadow federation). When the sandbox
  token file exists, the plugin uses it or fails. It never falls back to a key.
- **Loud failures.** Refresher errors carry `BACKOFFICE_JOB_FAILURE`, which triggers the
  existing CloudWatch alarm and its Google Chat notification. A dead refresher stops
  every agent within about 5 minutes.

## One-time human prerequisites (per environment)

1. **AWS account (affects the whole account, one time):**
   `aws iam enable-outbound-web-identity-federation`, then
   `aws iam get-outbound-web-identity-federation-info` to read the issuer URL
   (`https://<uuid>.tokens.sts.global.api.aws`). Enabling it grants nothing by itself:
   a principal also needs `sts:GetWebIdentityToken`, which only the Paperclip role gets,
   and only in federation mode.
2. **Deploy this PR in `api_key` mode first.** This creates the dedicated role. Read its
   ARN from the Terraform output `paperclip_task_role_arn`.
3. **Claude Console (admin role), Settings → Workload identity federation.** Use the
   Console: on our organization (type "Individual Org"), the Admin API answers 404/403
   even with an `org:admin` OAuth token, so `ant organization:*` cannot manage it.
   Service accounts are created inside the **Connect workload** wizard, and the manual
   rule form's target list only shows existing ones.
   - **Issuer:** the URL from step 1, `jwks: discovery`.
   - **Service accounts:** `backoffice-agents-<env>` and `backoffice-sandbox-<env>`, members of the backoffice workspace.
   - **Rule "agents":**
     - match `subject_prefix` = the exact role ARN (no `*`; the ARN already pins the AWS account) and `audience` = `anthropic-agents`. The `claims` matcher only compares top-level strings, and the AWS claims are nested under `https://sts.amazonaws.com/`, so any extra check goes in a CEL `condition` (for example on `aws_account`);
     - target the agents service account;
     - `workspace:developer` (`workspace:inference` when available);
     - lifetime 3600 s;
     - (the jti check is set on the issuer, see below).
   - **Rule "sandbox":** same match but `audience` = `anthropic-sandbox`, sandbox service account, lifetime **1800 s**.
   - **Issuer:** disable the jti (replay) check.
   - Record the ids: organization, workspace (only if the rule spans several), both rule ids, both service-account ids.
4. **PR: flip the environment.** In `environments/<env>/main.tf`, set
   `anthropic_auth = "federation"` and fill `anthropic_federation` with the ids. They are
   identifiers, not secrets. A plan precondition refuses federation without the agents ids.

## Validation on staging (before production, before revoking any key)

1. The container logs `anthropic-federation: initial refresh done {"ok":true}` and then a
   sandbox token mint, with no `BACKOFFICE_JOB_FAILURE` from `anthropic-federation`.
2. One Methods Officer run completes. The Console authentication history shows exchanges
   for the agents service account.
3. **Two agent runs in parallel** both complete. This proves the `check_jti` decision.
4. One `sandbox_code_task` completes with `ANTHROPIC_AUTH_TOKEN` in the Sprite. This
   pattern is not documented by Anthropic and is the main thing to prove.
5. **Costs and budgets.** Paperclip derives `billingType` from the presence of
   `ANTHROPIC_API_KEY`, so federated runs are labelled `subscription` instead of `api`.
   Confirm that `costUsd` is still recorded and that a budget still blocks. Re-check this
   during the 2026.1023 upgrade, which blocks "unpriced" usage by default.
6. Only then: remove `ANTHROPIC_API_KEY` from the app secret and **revoke the old keys**,
   including the former CEO key (last used around 2026-06-21).

## Rollback

Set `anthropic_auth = "api_key"` and deploy. The key must still exist in the app secret,
so revoke it only after a full validation period. The dedicated role stays: it is
harmless without the identity-token policy.

## Known limits

- Anthropic does not document handing a minted token to a remote sandbox. It is a plain
  Bearer token for `/v1/messages`, and validation step 4 proves it.
- The Paperclip UI model list (`models.js`) and quota polling read `ANTHROPIC_API_KEY`,
  so they degrade without it. Agent runs are not affected.
- The refresher runs inside the Paperclip container. If it is killed while the container
  lives, the entrypoint loop restarts it within 5 s.

## Staging configuration (2026-11-06)

| Object                           | Id                                                                       |
| -------------------------------- | ------------------------------------------------------------------------ |
| AWS issuer                       | `https://a1b087d2-6ee6-4f21-be3a-8d0a53982b58.tokens.sts.global.api.aws` |
| Anthropic issuer `henri-staging` | `fdis_019yLw7Ucfc5SQhUV7HKXCmS` (jti check disabled)                     |
| Rule "agents"                    | `fdrl_01Rdq3ESaHNYnN3kXgb1ULeC`                                          |
| Rule "sandbox"                   | `fdrl_018D9jNBmyfGGJ3GfzGh2o4F`                                          |
| Paperclip task role              | `arn:aws:iam::980539927939:role/gs-backoffice-staging-paperclip-task`    |

Negative test (2026-11-06): JWTs minted for another principal of the account
(`admin-terraform`) with both audiences were refused by the exchange (HTTP 401).
