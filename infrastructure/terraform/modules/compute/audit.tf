# A separate queue decouples audit delivery from both EVT and notifications.
resource "aws_sqs_queue" "audit" {
  name                       = "${var.project_name}-${var.environment}-audit"
  message_retention_seconds  = 1209600
  visibility_timeout_seconds = 60
  receive_wait_time_seconds  = 20
  sqs_managed_sse_enabled    = true
  # No automatic maxReceiveCount redrive: an EVT outage must not exhaust attempts.
}
resource "aws_sqs_queue" "audit_dlq" {
  name                      = "${var.project_name}-${var.environment}-audit-failed"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}
resource "aws_sqs_queue_policy" "audit_tls" {
  for_each  = { main = aws_sqs_queue.audit, failed = aws_sqs_queue.audit_dlq }
  queue_url = each.value.url
  policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect    = "Deny", Principal = "*", Action = "sqs:*", Resource = each.value.arn,
    Condition = { Bool = { "aws:SecureTransport" = "false" } }
  }] })
}
resource "aws_iam_role_policy" "audit_producer" {
  name = "${var.project_name}-${var.environment}-audit-producer"
  role = aws_iam_role.ecs_task.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["sqs:SendMessage"], Resource = aws_sqs_queue.audit.arn },
    { Effect = "Allow", Action = ["cloudwatch:PutMetricData"], Resource = "*", Condition = { StringEquals = { "cloudwatch:namespace" = "GsBackoffice/${var.environment}" } } },
    { Effect = "Allow", Action = ["s3:PutObject"], Resource = "${aws_s3_bucket.paperclip_run_logs.arn}/audit/*" }
  ] })
}
# Delivery has a separate role: producers cannot consume/delete the audit queue.
resource "aws_iam_role" "audit_consumer" {
  name = "${var.project_name}-${var.environment}-audit-consumer"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect = "Allow", Action = "sts:AssumeRole", Principal = { Service = "ecs-tasks.amazonaws.com" }
  }] })
}
resource "aws_iam_role_policy" "audit_consumer" {
  name = "audit-delivery"
  role = aws_iam_role.audit_consumer.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility"], Resource = aws_sqs_queue.audit.arn },
    { Effect = "Allow", Action = ["sqs:SendMessage"], Resource = aws_sqs_queue.audit_dlq.arn }
  ] })
}
resource "aws_cloudwatch_log_group" "audit" {
  name              = "/ecs/${var.project_name}-${var.environment}/audit-consumer"
  retention_in_days = 30
}
resource "aws_ecs_task_definition" "audit" {
  family                   = "${var.project_name}-${var.environment}-audit"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.audit_consumer.arn
  container_definitions = jsonencode([{
    name    = "audit-consumer", image = "${var.ecr_mcp_url}:${var.image_tag}", essential = true,
    command = ["node", "apps/audit-consumer/dist/index.js"],
    environment = [
      { name = "NODE_ENV", value = var.environment },
      { name = "AWS_REGION", value = var.aws_region },
      { name = "AUDIT_QUEUE_URL", value = aws_sqs_queue.audit.url },
      { name = "AUDIT_DLQ_URL", value = aws_sqs_queue.audit_dlq.url }
    ],
    secrets = [for key in ["EVT_API_URL", "EVT_API_KEY"] : { name = key, valueFrom = "${var.app_secrets_arn}:${key}::" }],
    logConfiguration = { logDriver = "awslogs", options = {
      "awslogs-group"  = aws_cloudwatch_log_group.audit.name,
      "awslogs-region" = var.aws_region, "awslogs-stream-prefix" = "ecs"
    } }
  }])
}
resource "aws_ecs_service" "audit" {
  name            = "audit-consumer"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.audit.arn
  desired_count   = 1
  launch_type     = "FARGATE"
  # One consumer, including during deployments: avoid multiplying the recovery rate.
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100
  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [var.ecs_security_group_id]
    assign_public_ip = false
  }
  depends_on = [aws_iam_role_policy.audit_consumer, aws_sqs_queue_policy.audit_tls]
}
output "audit_queue_name" { value = aws_sqs_queue.audit.name }
output "audit_dlq_name" { value = aws_sqs_queue.audit_dlq.name }
output "audit_log_group_name" { value = aws_cloudwatch_log_group.audit.name }
output "mcp_log_group_name" { value = aws_cloudwatch_log_group.mcp.name }
