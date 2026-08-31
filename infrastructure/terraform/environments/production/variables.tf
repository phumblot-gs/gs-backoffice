variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "eu-west-1"
}

variable "environment" {
  description = "Environment name"
  type        = string
  default     = "production"
}

variable "project_name" {
  description = "Project name"
  type        = string
  default     = "gs-backoffice"
}

# Domains
variable "paperclip_domain" {
  description = "Domain for Paperclip dashboard"
  type        = string
  default     = "backoffice.grand-shooting.com"
}

variable "mcp_domain" {
  description = "Domain for MCP server"
  type        = string
  default     = "mcp-backoffice.grand-shooting.com"
}

# Database
variable "db_instance_class" {
  description = "RDS instance class"
  type        = string
  default     = "db.t4g.small"
}

# Compute
variable "paperclip_cpu" {
  description = "CPU units for Paperclip"
  type        = number
  default     = 512
}

variable "paperclip_memory" {
  description = "Memory in MB for Paperclip"
  type        = number
  default     = 1024
}

variable "mcp_cpu" {
  description = "CPU units for MCP server"
  type        = number
  default     = 512
}

variable "mcp_memory" {
  description = "Memory in MB for MCP server"
  type        = number
  default     = 1024
}

# ECR
variable "ecr_paperclip_url" {
  description = "ECR repository URL for Paperclip"
  type        = string
}

variable "ecr_mcp_url" {
  description = "ECR repository URL for MCP server"
  type        = string
}

variable "image_tag" {
  description = "Docker image tag to deploy"
  type        = string
  default     = "latest"
}

# Monitoring
variable "alert_email" {
  description = "Email for alert notifications"
  type        = string
  default     = ""
}
