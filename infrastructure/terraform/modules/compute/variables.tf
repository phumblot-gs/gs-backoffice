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
