variable "environment" {
  description = "Environment name"
  type        = string
}

variable "project_name" {
  description = "Project name"
  type        = string
  default     = "gs-backoffice"
}

variable "vpc_id" {
  description = "VPC ID"
  type        = string
}

variable "public_subnet_ids" {
  description = "Public subnet IDs for ALB"
  type        = list(string)
}

variable "alb_security_group_id" {
  description = "ALB security group ID"
  type        = string
}

variable "paperclip_domain" {
  description = "Domain for Paperclip dashboard (e.g., backoffice-staging.grand-shooting.com)"
  type        = string
}

variable "mcp_domain" {
  description = "Domain for MCP server (e.g., mcp-backoffice-staging.grand-shooting.com)"
  type        = string
}
