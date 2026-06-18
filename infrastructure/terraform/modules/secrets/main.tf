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
    PAPERCLIP_COMPANY_ID    = "CHANGE_ME"
    CHIEF_OF_STAFF_AGENT_ID = "CHANGE_ME"
    JUMPCLOUD_API_KEY       = "CHANGE_ME"
    JUMPCLOUD_ORG_ID        = "CHANGE_ME"
    # JSON map {scope: webhookUrl} consumed by the notify-consumer; "{}" = no
    # channels yet (notifications are logged + skipped until populated).
    GOOGLE_CHAT_WEBHOOKS = "{}"
  })

  lifecycle {
    ignore_changes = [secret_string]
  }
}
