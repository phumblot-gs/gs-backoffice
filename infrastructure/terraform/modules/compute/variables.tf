variable "environment" {
  description = "Environment name"
  type        = string
}

variable "project_name" {
  description = "Project name"
  type        = string
  default     = "gs-backoffice"
}

variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "eu-west-1"
}

variable "vpc_id" {
  description = "VPC ID (for the private DNS namespace used by service discovery)"
  type        = string
}

variable "private_subnet_ids" {
  description = "Private subnet IDs for ECS tasks"
  type        = list(string)
}

variable "ecs_security_group_id" {
  description = "ECS security group ID"
  type        = string
}

variable "paperclip_target_group_arn" {
  description = "ALB target group ARN for Paperclip"
  type        = string
}

variable "mcp_target_group_arn" {
  description = "ALB target group ARN for MCP server"
  type        = string
}

variable "ecr_paperclip_url" {
  description = "ECR repository URL for Paperclip image"
  type        = string
}

variable "ecr_mcp_url" {
  description = "ECR repository URL for MCP server image"
  type        = string
}

variable "image_tag" {
  description = "Docker image tag to deploy"
  type        = string
  default     = "latest"
}

variable "db_secret_arn" {
  description = "ARN of the DB credentials secret"
  type        = string
}

variable "app_secrets_arn" {
  description = "ARN of the application secrets"
  type        = string
}

variable "paperclip_cpu" {
  description = "CPU units for Paperclip task (256 = 0.25 vCPU)"
  type        = number
  default     = 256
}

variable "paperclip_memory" {
  description = "Memory in MB for Paperclip task"
  type        = number
  default     = 512
}

variable "paperclip_allowed_hostnames" {
  description = "Comma-separated allowed hostnames for Paperclip authenticated mode"
  type        = string
  default     = ""
}

variable "paperclip_public_url" {
  description = "Public URL for Paperclip (used for auth callbacks)"
  type        = string
}

variable "backoffice_repo_url" {
  description = "Repo the self-evolution bridge operates on when the agent omits repoUrl (not a secret)."
  type        = string
  default     = "https://github.com/phumblot-gs/gs-backoffice.git"
}

variable "mcp_cpu" {
  description = "CPU units for MCP server task"
  type        = number
  default     = 256
}

variable "mcp_memory" {
  description = "Memory in MB for MCP server task"
  type        = number
  default     = 512
}

variable "notify_cpu" {
  description = "CPU units for the notify-consumer task"
  type        = number
  default     = 256
}

variable "notify_memory" {
  description = "Memory in MB for the notify-consumer task"
  type        = number
  default     = 512
}

variable "paperclip_disable_signup" {
  description = <<-EOT
    Close public account creation on the Paperclip UI. The ALB is internet-facing and
    `POST /api/auth/sign-up/email` was reachable by anyone: bots registered ~5 accounts
    a month on staging on their own (they could not sign in — Paperclip's own gate
    returns 403 — but the rows are real).

    Paperclip 609 exposes no invite-only switch in config.json; `auth.disableSignUp` is
    the only lever, and invitations go through the same endpoint as public sign-up. So
    closing this also closes onboarding, by design:

      onboarding runbook — set this to false, apply, send the invite, set it back to
      true, apply. Two deploys, and the window is auditable in the PR history.

    Also required false when bootstrapping the very first admin on a fresh environment
    (`paperclipai auth bootstrap-ceo`).
  EOT
  type        = bool
  default     = true
}

variable "paperclip_secret_prefix" {
  description = <<-EOT
    Name prefix for the secrets Paperclip manages in AWS Secrets Manager through its
    own provider (`aws_secrets_manager`). Must match the `secretNamePrefix` configured
    in Paperclip, or the IAM grant and the provider will disagree and every resolution
    will fail with AccessDenied. Paperclip's own default is "paperclip".
  EOT
  type        = string
  default     = "paperclip"
}

variable "paperclip_resolved_secret_path" {
  description = <<-EOT
    Secrets Manager path holding the secrets Paperclip resolves as EXTERNAL references
    — values we own in Terraform, that Paperclip reads but never writes. Distinct from
    `paperclip_secret_prefix`, which is where Paperclip stores secrets it manages
    itself. Both are granted; they answer different questions.
  EOT
  type        = string
}

variable "anthropic_auth" {
  description = <<-EOT
    How the Paperclip container authenticates to Anthropic.
      api_key    — the static ANTHROPIC_API_KEY from the app secret (legacy).
      federation — workload identity federation: no static key; an AWS STS web identity
                   token for the Paperclip task role, exchanged by Claude Code, plus a
                   short-lived sandbox token. See docs/architecture/anthropic-federation.md.
    Switching back to api_key is the rollback.
  EOT
  type        = string
  default     = "api_key"

  validation {
    condition     = contains(["api_key", "federation"], var.anthropic_auth)
    error_message = "anthropic_auth must be \"api_key\" or \"federation\"."
  }
}

variable "anthropic_federation" {
  description = <<-EOT
    Anthropic workload identity federation identifiers (not secrets), from the Claude
    Console. Required when anthropic_auth = "federation" (agents_*, organization_id);
    the sandbox_* trio is optional and enables the short-lived sandbox token.
  EOT
  type = object({
    organization_id            = optional(string, "")
    workspace_id               = optional(string, "")
    agents_rule_id             = optional(string, "")
    agents_service_account_id  = optional(string, "")
    agents_audience            = optional(string, "anthropic-agents")
    sandbox_rule_id            = optional(string, "")
    sandbox_service_account_id = optional(string, "")
    sandbox_audience           = optional(string, "anthropic-sandbox")
  })
  default = {}

  validation {
    condition = trimspace(var.anthropic_federation.sandbox_rule_id) == "" || (
      trimspace(var.anthropic_federation.sandbox_service_account_id) != "" &&
      var.anthropic_federation.sandbox_audience != var.anthropic_federation.agents_audience
    )
    error_message = "sandbox_rule_id requires sandbox_service_account_id and a sandbox_audience distinct from agents_audience."
  }
}
