output "ecs_cluster_name" {
  description = "ECS cluster name"
  value       = aws_ecs_cluster.main.name
}

output "ecs_cluster_arn" {
  description = "ECS cluster ARN"
  value       = aws_ecs_cluster.main.arn
}

output "paperclip_service_name" {
  description = "Paperclip ECS service name"
  value       = aws_ecs_service.paperclip.name
}

output "mcp_service_name" {
  description = "MCP server ECS service name"
  value       = aws_ecs_service.mcp.name
}
