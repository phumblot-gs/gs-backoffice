# Native Paperclip warnings do not emit BACKOFFICE_JOB_FAILURE. Track these
# separately from scheduled jobs so a healthy HTTP server cannot hide failures.
locals {
  paperclip_health_signals = {
    tool_connection = {
      pattern     = "\"periodic tool connection health sweep found failing connections\""
      metric_name = "ToolConnectionHealthFailures"
      description = "Paperclip reports repeatedly failing tool connections; inspect the board tool connection health details."
      # Health sweeps run every 15 minutes. A full hour avoids OK/ALARM flapping
      # between sweeps; two failures suppress a single transient probe failure.
      period    = 3600
      threshold = 2
    }
    run_log_mirror = {
      pattern     = "\"[run-log-store]\" \"Failed to mirror\""
      metric_name = "RunLogMirrorFailures"
      description = "Paperclip could not copy an agent run log to S3. The local log may be lost when the ECS task is replaced."
      period      = 300
      threshold   = 1
    }
  }
}

resource "aws_cloudwatch_log_metric_filter" "paperclip_health" {
  for_each       = local.paperclip_health_signals
  name           = "${var.project_name}-${var.environment}-${replace(each.key, "_", "-")}"
  log_group_name = var.paperclip_log_group_name
  pattern        = each.value.pattern

  metric_transformation {
    name          = each.value.metric_name
    namespace     = local.metric_namespace
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "paperclip_health" {
  for_each            = local.paperclip_health_signals
  alarm_name          = "${var.project_name}-${var.environment}-${replace(each.key, "_", "-")}"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = each.value.metric_name
  namespace           = local.metric_namespace
  period              = each.value.period
  statistic           = "Sum"
  threshold           = each.value.threshold
  alarm_description   = each.value.description
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"
}
