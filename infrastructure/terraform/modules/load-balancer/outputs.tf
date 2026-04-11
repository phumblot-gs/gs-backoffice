output "alb_dns_name" {
  description = "ALB DNS name (use as CNAME target)"
  value       = aws_lb.main.dns_name
}

output "alb_zone_id" {
  description = "ALB hosted zone ID"
  value       = aws_lb.main.zone_id
}

output "alb_arn_suffix" {
  description = "ALB ARN suffix (for CloudWatch metrics)"
  value       = aws_lb.main.arn_suffix
}

output "paperclip_target_group_arn" {
  description = "Paperclip target group ARN"
  value       = aws_lb_target_group.paperclip.arn
}

output "mcp_target_group_arn" {
  description = "MCP server target group ARN"
  value       = aws_lb_target_group.mcp.arn
}

output "acm_certificate_validation_records" {
  description = "DNS records to create for ACM certificate validation"
  value = {
    for dvo in aws_acm_certificate.main.domain_validation_options : dvo.domain_name => {
      name  = dvo.resource_record_name
      type  = dvo.resource_record_type
      value = dvo.resource_record_value
    }
  }
}
