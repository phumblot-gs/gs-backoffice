output "paperclip_repo_url" {
  description = "ECR repository URL for Paperclip"
  value       = module.ecr.paperclip_repo_url
}

output "mcp_repo_url" {
  description = "ECR repository URL for MCP server"
  value       = module.ecr.mcp_repo_url
}
