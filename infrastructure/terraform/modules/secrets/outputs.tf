output "app_secrets_arn" {
  description = "ARN of the application secrets"
  value       = aws_secretsmanager_secret.app.arn
}

output "paperclip_secret_arns" {
  description = "ARNs of the individually-stored secrets Paperclip resolves, keyed by short name. Paste these into Paperclip as external references."
  value       = { for k, v in aws_secretsmanager_secret.paperclip : k => v.arn }
}

output "paperclip_secret_path_prefix" {
  description = "Secrets Manager path holding the secrets Paperclip resolves (the IAM grant is scoped to it)"
  value       = "${var.project_name}/${var.environment}/paperclip"
}
