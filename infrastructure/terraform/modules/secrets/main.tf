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
    BETTER_AUTH_SECRET      = "CHANGE_ME"
    ANTHROPIC_API_KEY       = "CHANGE_ME"
    EVT_API_URL             = "https://api.events.grand-shooting.com"
    EVT_API_KEY             = "CHANGE_ME"
    EVT_ACCOUNT_ID          = "CHANGE_ME"
    PAPERCLIP_API_URL       = "http://localhost:3100"
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
    # Stable key for Paperclip's local_encrypted secret store, so company secrets
    # survive redeploys on ephemeral Fargate (entrypoint writes it to master.key).
    PAPERCLIP_SECRETS_MASTER_KEY = "CHANGE_ME"
  })

  lifecycle {
    ignore_changes = [secret_string]
  }
}
