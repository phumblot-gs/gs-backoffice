output "paperclip_repo_url" {
  description = "ECR repository URL for Paperclip"
  value       = aws_ecr_repository.paperclip.repository_url
}

output "mcp_repo_url" {
  description = "ECR repository URL for MCP server"
  value       = aws_ecr_repository.mcp.repository_url
}

output "paperclip_repo_arn" {
  description = "ECR repository ARN for Paperclip"
  value       = aws_ecr_repository.paperclip.arn
}

output "mcp_repo_arn" {
  description = "ECR repository ARN for MCP server"
  value       = aws_ecr_repository.mcp.arn
}
