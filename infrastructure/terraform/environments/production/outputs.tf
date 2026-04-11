output "alb_dns_name" {
  description = "ALB DNS name — create CNAME records pointing your domains to this"
  value       = module.load_balancer.alb_dns_name
}

output "acm_certificate_validation_records" {
  description = "DNS records to create for ACM certificate validation"
  value       = module.load_balancer.acm_certificate_validation_records
}

output "db_endpoint" {
  description = "RDS endpoint"
  value       = module.database.db_endpoint
}

output "ecs_cluster_name" {
  description = "ECS cluster name"
  value       = module.compute.ecs_cluster_name
}

output "dashboard_url" {
  description = "CloudWatch Dashboard URL"
  value       = module.monitoring.dashboard_url
}

output "domains" {
  description = "Configured domains"
  value = {
    paperclip = var.paperclip_domain
    mcp       = var.mcp_domain
  }
}
