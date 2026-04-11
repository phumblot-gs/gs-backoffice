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
