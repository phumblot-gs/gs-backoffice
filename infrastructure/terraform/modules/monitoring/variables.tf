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

variable "ecs_cluster_name" {
  description = "ECS cluster name"
  type        = string
}

variable "paperclip_service_name" {
  description = "Paperclip ECS service name"
  type        = string
}

variable "mcp_service_name" {
  description = "MCP server ECS service name"
  type        = string
}

variable "db_instance_identifier" {
  description = "RDS instance identifier"
  type        = string
}

variable "alb_arn_suffix" {
  description = "ALB ARN suffix"
  type        = string
}

variable "alert_email" {
  description = "Email for alert notifications (empty = no subscription)"
  type        = string
  default     = ""
}
