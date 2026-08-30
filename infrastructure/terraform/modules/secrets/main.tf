# -----------------------------------------------------------------------------
# Application Secrets (populated manually after first deploy)
# -----------------------------------------------------------------------------
resource "aws_secretsmanager_secret" "app" {
  name                    = "${var.project_name}/${var.environment}/app"
  recovery_window_in_days = var.environment == "production" ? 30 : 0

  tags = {
    Name = "${var.project_name}-${var.environment}-app-secrets"
  }
}

resource "aws_secretsmanager_secret_version" "app" {
  secret_id = aws_secretsmanager_secret.app.id
  secret_string = jsonencode({
    BETTER_AUTH_SECRET = "CHANGE_ME"
    ANTHROPIC_API_KEY  = "CHANGE_ME"
    EVT_API_URL        = "https://api.events.grand-shooting.com"
    EVT_API_KEY        = "CHANGE_ME"
    EVT_ACCOUNT_ID     = "CHANGE_ME"
    # PAPERCLIP_API_URL deliberately absent: it is not a secret, and one shared
    # value cannot serve both containers (Paperclip's plugins need loopback, the
    # MCP server needs a routable address). It lives in each task definition's
    # `environment` instead. Existing environments keep a now-unused key in the
    # live secret — harmless, since `ignore_changes` never rewrites it.
    PAPERCLIP_API_KEY       = "CHANGE_ME"
    PAPERCLIP_COMPANY_ID    = "CHANGE_ME"
    CHIEF_OF_STAFF_AGENT_ID = "CHANGE_ME"
    JUMPCLOUD_API_KEY       = "CHANGE_ME"
    JUMPCLOUD_ORG_ID        = "CHANGE_ME"
    # JSON map {scope: webhookUrl} consumed by the notify-consumer; "{}" = no
    # channels yet (notifications are logged + skipped until populated).
    GOOGLE_CHAT_WEBHOOKS = "{}"
    # Fly Sprites API token (sprites.dev) for the sandbox-provider plugin.
    SPRITES_TOKEN = "CHANGE_ME"
    # GitHub token(s) for the sandbox tools (clone/push from inside a Sprite).
    # Fine-grained PATs for now; GitHub App tokens in production.
    #  - SANDBOX_GITHUB_TOKEN: combined fallback (contents + PR rw).
    #  - SANDBOX_GITHUB_READ_TOKEN: read-only (verification / sandbox_run).
    #  - SANDBOX_GITHUB_PUSH_TOKEN: push-capable (sandbox_code_task).
    SANDBOX_GITHUB_TOKEN      = "CHANGE_ME"
    SANDBOX_GITHUB_READ_TOKEN = "CHANGE_ME"
    SANDBOX_GITHUB_PUSH_TOKEN = "CHANGE_ME"
    # GitHub App "GRAFMAKER Henri": the bridge mints short-lived installation tokens so
    # PRs are bot-authored (author != approver, SOC2 CC8). Set out-of-band via
    # ~/gs-set-github-app.sh. Placeholder/absent → bridge falls back to the PATs above.
    GITHUB_APP_ID              = "CHANGE_ME"
    GITHUB_APP_INSTALLATION_ID = "CHANGE_ME"
    GITHUB_APP_PRIVATE_KEY     = "CHANGE_ME"
    # Stable key for Paperclip's local_encrypted secret store, so company secrets
    # survive redeploys on ephemeral Fargate (entrypoint writes it to master.key).
    PAPERCLIP_SECRETS_MASTER_KEY = "CHANGE_ME"
  })

  lifecycle {
    ignore_changes = [secret_string]
  }
}

# -----------------------------------------------------------------------------
# Individually-stored secrets, referenced by Paperclip
#
# Paperclip resolves a secret reference by calling GetSecretValue on ONE AWS secret
# and taking its whole SecretString. It cannot pull a key out of a JSON document, so
# the values it resolves cannot live in the `app` blob above — hence one secret each.
#
# They are created EMPTY on purpose. Terraform must never hold a real credential, and
# `ignore_changes` means an operator can set the value out-of-band exactly once and no
# later apply will touch it — the same contract the app blob already has.
#
# Nothing consumes these until the references are declared in Paperclip. Creating them
# is therefore inert: no task definition points here, and an empty value cannot break
# a container that never reads it.
#
# Only genuine secrets are split out. Identifiers that merely need to travel with them
# (GITHUB_APP_ID, EVT_ACCOUNT_ID, the URLs) stay ordinary configuration.
# -----------------------------------------------------------------------------
locals {
  paperclip_resolved_secrets = [
    "sprites-token",
    "anthropic-api-key",
    "github-app-private-key",
    "evt-api-key",
    "paperclip-api-key",
  ]
}

resource "aws_secretsmanager_secret" "paperclip" {
  for_each = toset(local.paperclip_resolved_secrets)

  name                    = "${var.project_name}/${var.environment}/paperclip/${each.key}"
  recovery_window_in_days = var.environment == "production" ? 30 : 0

  tags = {
    Name = "${var.project_name}-${var.environment}-${each.key}"
    # Marks the set Paperclip is allowed to read; the IAM grant matches this path.
    ResolvedBy = "paperclip"
  }
}

resource "aws_secretsmanager_secret_version" "paperclip" {
  for_each = aws_secretsmanager_secret.paperclip

  secret_id     = each.value.id
  secret_string = "CHANGE_ME"

  lifecycle {
    ignore_changes = [secret_string]
  }
}
