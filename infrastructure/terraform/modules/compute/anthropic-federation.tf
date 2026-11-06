# -----------------------------------------------------------------------------
# Keyless Anthropic auth — workload identity federation
# (docs/architecture/anthropic-federation.md)
#
# The Paperclip task gets its OWN role: the Anthropic federation rules trust a JWT whose
# `sub` is this role's ARN, so a role shared with MCP / notify would let those services
# mint Anthropic tokens too. It carries the same app permissions as the shared role
# (the policies below use local.app_task_roles) plus sts:GetWebIdentityToken in
# federation mode only.
# -----------------------------------------------------------------------------

resource "aws_iam_role" "paperclip_task" {
  name = "${var.project_name}-${var.environment}-paperclip-task"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      # Confused-deputy guard: only ECS tasks of this account may assume it.
      Condition = {
        StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id }
        ArnLike      = { "aws:SourceArn" = "arn:aws:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:*" }
      }
    }]
  })
}

locals {
  # Roles carrying the application permissions (secrets, run logs, audit producer).
  app_task_roles = {
    shared    = aws_iam_role.ecs_task.id
    paperclip = aws_iam_role.paperclip_task.id
  }

  federation = var.anthropic_auth == "federation"

  # Identifiers, not secrets: rule / organization / service-account / workspace ids.
  anthropic_federation_env = local.federation ? concat([
    { name = "GS_ANTHROPIC_AUTH", value = "federation" },
    { name = "ANTHROPIC_FEDERATION_RULE_ID", value = var.anthropic_federation.agents_rule_id },
    { name = "ANTHROPIC_ORGANIZATION_ID", value = var.anthropic_federation.organization_id },
    { name = "ANTHROPIC_SERVICE_ACCOUNT_ID", value = var.anthropic_federation.agents_service_account_id },
    { name = "ANTHROPIC_IDENTITY_TOKEN_FILE", value = "/run/anthropic/identity.jwt" },
    { name = "GS_ANTHROPIC_AGENTS_AUDIENCE", value = var.anthropic_federation.agents_audience },
    ], trimspace(var.anthropic_federation.workspace_id) != "" ? [
    { name = "ANTHROPIC_WORKSPACE_ID", value = var.anthropic_federation.workspace_id },
    ] : [], trimspace(var.anthropic_federation.sandbox_rule_id) != "" ? [
    { name = "GS_ANTHROPIC_SANDBOX_RULE_ID", value = var.anthropic_federation.sandbox_rule_id },
    { name = "GS_ANTHROPIC_SANDBOX_SERVICE_ACCOUNT_ID", value = var.anthropic_federation.sandbox_service_account_id },
    { name = "GS_ANTHROPIC_SANDBOX_AUDIENCE", value = var.anthropic_federation.sandbox_audience },
    { name = "GS_ANTHROPIC_SANDBOX_TOKEN_FILE", value = "/run/anthropic/sandbox-token" },
  ] : []) : [{ name = "GS_ANTHROPIC_AUTH", value = "api_key" }]

  identity_token_audiences = concat(
    [{ audience = var.anthropic_federation.agents_audience, max_seconds = 300 }],
    trimspace(var.anthropic_federation.sandbox_rule_id) != "" ? [
      { audience = var.anthropic_federation.sandbox_audience, max_seconds = 900 },
    ] : [],
  )
}

# STS outbound web identity tokens for the two Anthropic audiences only, short-lived,
# RS256. Requires the account-level switch (aws iam enable-outbound-web-identity-federation),
# which is a one-time human step — see the runbook.
resource "aws_iam_role_policy" "paperclip_identity_token" {
  count = local.federation ? 1 : 0
  name  = "anthropic-identity-token"
  role  = aws_iam_role.paperclip_task.id

  # One statement per audience, each with its own maximum lifetime:
  #  - agents: 300 s — Claude Code re-reads the file and re-exchanges as needed;
  #  - sandbox: 900 s — Anthropic caps the access token at 2 x the JWT's remaining
  #    lifetime, and the sandbox needs a 30-min token.
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [for a in local.identity_token_audiences : {
      Effect   = "Allow"
      Action   = ["sts:GetWebIdentityToken"]
      Resource = "*"
      Condition = {
        # Every requested audience must be this one, and the key must be present
        # (ForAllValues passes vacuously on an absent key).
        "ForAllValues:StringEquals" = { "sts:IdentityTokenAudience" = [a.audience] }
        Null                        = { "sts:IdentityTokenAudience" = "false" }
        NumericLessThanEquals       = { "sts:DurationSeconds" = a.max_seconds }
        StringEquals                = { "sts:SigningAlgorithm" = "RS256" }
      }
    }]
  })
}
