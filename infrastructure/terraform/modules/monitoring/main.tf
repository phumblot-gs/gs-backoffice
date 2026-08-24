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
