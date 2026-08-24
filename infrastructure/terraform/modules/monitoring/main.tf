# -----------------------------------------------------------------------------
# SNS Topic for Alerts
# -----------------------------------------------------------------------------
resource "aws_sns_topic" "alerts" {
  name = "${var.project_name}-${var.environment}-alerts"
}

resource "aws_sns_topic_subscription" "email" {
  count     = var.alert_email != "" ? 1 : 0
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# -----------------------------------------------------------------------------
# CloudWatch Alarms
# -----------------------------------------------------------------------------
resource "aws_cloudwatch_metric_alarm" "ecs_paperclip_cpu" {
  alarm_name          = "${var.project_name}-${var.environment}-paperclip-cpu-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "CPUUtilization"
  namespace           = "AWS/ECS"
  period              = 300
  statistic           = "Average"
  threshold           = 80
  alarm_description   = "Paperclip ECS CPU > 80%"
  alarm_actions       = [aws_sns_topic.alerts.arn]

  dimensions = {
    ClusterName = var.ecs_cluster_name
    ServiceName = var.paperclip_service_name
  }
}

resource "aws_cloudwatch_metric_alarm" "rds_cpu" {
  alarm_name          = "${var.project_name}-${var.environment}-rds-cpu-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "CPUUtilization"
  namespace           = "AWS/RDS"
  period              = 300
  statistic           = "Average"
  threshold           = 80
  alarm_description   = "RDS CPU > 80%"
  alarm_actions       = [aws_sns_topic.alerts.arn]

  dimensions = {
    DBInstanceIdentifier = var.db_instance_identifier
  }
}

resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
  alarm_name          = "${var.project_name}-${var.environment}-alb-5xx-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "HTTPCode_ELB_5XX_Count"
  namespace           = "AWS/ApplicationELB"
  period              = 300
  statistic           = "Sum"
  threshold           = 10
  alarm_description   = "ALB 5xx errors > 10 in 5 min"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    LoadBalancer = var.alb_arn_suffix
  }
}

# -----------------------------------------------------------------------------
# Application-level alarm: scheduled-job failures
#
# The infra alarms above (CPU, 5xx) only see the container. They cannot see a
# scheduled job that fails while the service stays perfectly healthy — which is
# exactly how the PR-review digest ran on a dead GitHub token for weeks while
# still posting a cheerful "aucune PR en attente" to Google Chat every morning.
#
# Jobs now log the JOB_FAILURE_MARKER string (see
# packages/sandbox-fly-sprites/src/tools.ts). This filter counts it and alarms on
# the first occurrence. The marker and the pattern below must stay in sync.
# -----------------------------------------------------------------------------
locals {
  job_failure_marker = "BACKOFFICE_JOB_FAILURE"
  metric_namespace   = "GsBackoffice/${var.environment}"
}

resource "aws_cloudwatch_log_metric_filter" "job_failure" {
  name           = "${var.project_name}-${var.environment}-job-failure"
  log_group_name = var.paperclip_log_group_name
  pattern        = "\"${local.job_failure_marker}\""

  metric_transformation {
    name      = "JobFailures"
    namespace = local.metric_namespace
    value     = "1"
    # Emit 0 on non-matching events so the metric always reports and the alarm
    # can return to OK on its own instead of sitting in INSUFFICIENT_DATA.
    default_value = "0"
    unit          = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "job_failure" {
  alarm_name          = "${var.project_name}-${var.environment}-job-failure"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = aws_cloudwatch_log_metric_filter.job_failure.metric_transformation[0].name
  namespace           = local.metric_namespace
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  alarm_description   = "A gs-backoffice scheduled job reported a failure (${local.job_failure_marker}) - e.g. the PR-review digest could not reach GitHub."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"
}

# -----------------------------------------------------------------------------
# CloudWatch Dashboard
# -----------------------------------------------------------------------------
resource "aws_cloudwatch_dashboard" "main" {
  dashboard_name = "${var.project_name}-${var.environment}"

  dashboard_body = jsonencode({
    widgets = [
      {
        type   = "metric"
        x      = 0
        y      = 0
        width  = 12
        height = 6
        properties = {
          title = "ECS CPU Utilization"
          metrics = [
            ["AWS/ECS", "CPUUtilization", "ClusterName", var.ecs_cluster_name, "ServiceName", var.paperclip_service_name, { label = "Paperclip" }],
            ["AWS/ECS", "CPUUtilization", "ClusterName", var.ecs_cluster_name, "ServiceName", var.mcp_service_name, { label = "MCP Server" }],
          ]
          region = var.aws_region
          period = 300
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 0
        width  = 12
        height = 6
        properties = {
          title = "ECS Memory Utilization"
          metrics = [
            ["AWS/ECS", "MemoryUtilization", "ClusterName", var.ecs_cluster_name, "ServiceName", var.paperclip_service_name, { label = "Paperclip" }],
            ["AWS/ECS", "MemoryUtilization", "ClusterName", var.ecs_cluster_name, "ServiceName", var.mcp_service_name, { label = "MCP Server" }],
          ]
          region = var.aws_region
          period = 300
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 6
        width  = 12
        height = 6
        properties = {
          title = "RDS"
          metrics = [
            ["AWS/RDS", "CPUUtilization", "DBInstanceIdentifier", var.db_instance_identifier, { label = "CPU %" }],
            ["AWS/RDS", "DatabaseConnections", "DBInstanceIdentifier", var.db_instance_identifier, { label = "Connections", yAxis = "right" }],
          ]
          region = var.aws_region
          period = 300
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 6
        width  = 12
        height = 6
        properties = {
          title = "ALB Requests"
          metrics = [
            ["AWS/ApplicationELB", "RequestCount", "LoadBalancer", var.alb_arn_suffix, { label = "Requests", stat = "Sum" }],
            ["AWS/ApplicationELB", "HTTPCode_ELB_5XX_Count", "LoadBalancer", var.alb_arn_suffix, { label = "5xx", stat = "Sum", color = "#d62728" }],
          ]
          region = var.aws_region
          period = 300
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 12
        width  = 24
        height = 6
        properties = {
          title = "Scheduled job failures (application)"
          metrics = [
            [local.metric_namespace, "JobFailures", { label = "Job failures", stat = "Sum", color = "#d62728" }],
          ]
          region = var.aws_region
          period = 300
          yAxis  = { left = { min = 0 } }
        }
      },
    ]
  })
}

# -----------------------------------------------------------------------------
# Alarm delivery: SNS → Lambda → Google Chat
#
# The alerts topic had no subscriber at all, so every alarm above fired into the
# void. Alerts are posted to Chat DIRECTLY by this Lambda rather than through the
# usual EVT → notify-consumer path, because the notify-consumer runs on the very
# ECS cluster these alarms watch — routing alerts through it would go silent
# exactly when it matters. The function stays outside the VPC so it needs neither
# the NAT gateway nor a healthy network path through the monitored stack.
# -----------------------------------------------------------------------------
data "archive_file" "alarm_forwarder" {
  type        = "zip"
  source_file = "${path.module}/../../../lambda/alarm-forwarder/index.mjs"
  output_path = "${path.module}/.build/alarm-forwarder.zip"
}

resource "aws_iam_role" "alarm_forwarder" {
  name = "${var.project_name}-${var.environment}-alarm-forwarder"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "alarm_forwarder" {
  name = "${var.project_name}-${var.environment}-alarm-forwarder"
  role = aws_iam_role.alarm_forwarder.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.alarm_forwarder.arn}:*"
      },
      {
        # Only the one secret, only read — the function needs GOOGLE_CHAT_WEBHOOKS.
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = var.app_secrets_arn
      },
    ]
  })
}

resource "aws_cloudwatch_log_group" "alarm_forwarder" {
  name              = "/aws/lambda/${var.project_name}-${var.environment}-alarm-forwarder"
  retention_in_days = 30
}

resource "aws_lambda_function" "alarm_forwarder" {
  function_name    = "${var.project_name}-${var.environment}-alarm-forwarder"
  role             = aws_iam_role.alarm_forwarder.arn
  handler          = "index.handler"
  runtime          = "nodejs22.x"
  timeout          = 15
  filename         = data.archive_file.alarm_forwarder.output_path
  source_code_hash = data.archive_file.alarm_forwarder.output_base64sha256

  environment {
    variables = {
      APP_SECRETS_ARN = var.app_secrets_arn
    }
  }

  depends_on = [aws_cloudwatch_log_group.alarm_forwarder]
}

resource "aws_lambda_permission" "alarm_forwarder_sns" {
  statement_id  = "AllowExecutionFromSNS"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.alarm_forwarder.function_name
  principal     = "sns.amazonaws.com"
  source_arn    = aws_sns_topic.alerts.arn
}

resource "aws_sns_topic_subscription" "alarm_forwarder" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "lambda"
  endpoint  = aws_lambda_function.alarm_forwarder.arn

  depends_on = [aws_lambda_permission.alarm_forwarder_sns]
}
