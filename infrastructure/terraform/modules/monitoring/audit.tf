variable "audit_queue_name" { type = string }
variable "audit_dlq_name" { type = string }
variable "audit_log_group_name" { type = string }
variable "mcp_log_group_name" { type = string }

# Logs are a second path when the direct PutMetricData attempt itself fails.
# Double counting is harmless: this is an any-failure alarm, not a delivery counter.
resource "aws_cloudwatch_log_metric_filter" "audit_deposit" {
  name           = "${var.project_name}-${var.environment}-audit-deposit"
  log_group_name = var.mcp_log_group_name
  pattern        = "\"BACKOFFICE_AUDIT_ENQUEUE_FAILURE\""
  metric_transformation {
    name          = "AuditDepositFailures"
    namespace     = local.metric_namespace
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

locals {
  audit_queue_alarms = {
    delay          = { queue = var.audit_queue_name, metric = "ApproximateAgeOfOldestMessage", threshold = 300 }
    backlog        = { queue = var.audit_queue_name, metric = "ApproximateNumberOfMessagesVisible", threshold = 10000 }
    failed         = { queue = var.audit_dlq_name, metric = "ApproximateNumberOfMessagesVisible", threshold = 1 }
    retention_risk = { queue = var.audit_queue_name, metric = "ApproximateAgeOfOldestMessage", threshold = 86400 }
  }
  audit_log_signals = {
    circuit        = { pattern = "\"AUDIT_CIRCUIT_OPEN\"", metric = "AuditCircuitOpen", period = 1800, threshold = 1, comparison = "GreaterThanOrEqualToThreshold", missing = "notBreaching" }
    consumer_error = { pattern = "\"AUDIT_CONSUMER_FAILURE\"", metric = "AuditConsumerFailure", period = 300, threshold = 1, comparison = "GreaterThanOrEqualToThreshold", missing = "notBreaching" }
    heartbeat      = { pattern = "\"AUDIT_CONSUMER_HEARTBEAT\"", metric = "AuditConsumerHeartbeat", period = 600, threshold = 1, comparison = "LessThanThreshold", missing = "breaching" }
  }
}
resource "aws_cloudwatch_metric_alarm" "audit_queue" {
  for_each            = local.audit_queue_alarms
  alarm_name          = "${var.project_name}-${var.environment}-audit-${replace(each.key, "_", "-")}"
  namespace           = "AWS/SQS"
  metric_name         = each.value.metric
  dimensions          = { QueueName = each.value.queue }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = each.value.threshold
  treat_missing_data  = "notBreaching"
  alarm_description   = "Audit delivery ${each.key}: inspect the audit consumer and archived evidence. SQS retention is 14 days; S3 audit evidence does not expire automatically."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}
resource "aws_cloudwatch_log_metric_filter" "audit" {
  for_each       = local.audit_log_signals
  name           = "${var.project_name}-${var.environment}-audit-${each.key}"
  log_group_name = var.audit_log_group_name
  pattern        = each.value.pattern
  metric_transformation {
    name          = each.value.metric
    namespace     = local.metric_namespace
    value         = "1"
    default_value = "0"
  }
}
resource "aws_cloudwatch_metric_alarm" "audit_consumer" {
  for_each            = local.audit_log_signals
  alarm_name          = "${var.project_name}-${var.environment}-audit-${replace(each.key, "_", "-")}"
  namespace           = local.metric_namespace
  metric_name         = aws_cloudwatch_log_metric_filter.audit[each.key].metric_transformation[0].name
  statistic           = "Sum"
  period              = each.value.period
  evaluation_periods  = 1
  comparison_operator = each.value.comparison
  threshold           = each.value.threshold
  treat_missing_data  = each.value.missing
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}
resource "aws_cloudwatch_metric_alarm" "audit_deposit" {
  alarm_name          = "${var.project_name}-${var.environment}-audit-deposit-failure"
  namespace           = local.metric_namespace
  metric_name         = "AuditDepositFailures"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}
