# -----------------------------------------------------------------------------
# ACM Certificate (DNS validation — manual CNAME creation required)
# -----------------------------------------------------------------------------
resource "aws_acm_certificate" "main" {
  domain_name               = var.paperclip_domain
  subject_alternative_names = [var.mcp_domain]
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = {
    Name = "${var.project_name}-${var.environment}-cert"
  }
}

# Wait for certificate validation (manual DNS step must be done first)
resource "aws_acm_certificate_validation" "main" {
  certificate_arn = aws_acm_certificate.main.arn

  timeouts {
    create = "30m"
  }
}

# -----------------------------------------------------------------------------
# Access logs
#
# The ALB is internet-facing and was keeping no record of who called it. The
# application logs in CloudWatch only contain what the app chose to write, and the
# app never sees a client IP — so when hostile accounts were found in the board on
# 2026-08-25 there was no way to attribute them, correlate them, or tell one
# scanner from a contracted vendor. Access logs are the only place the source IP,
# user agent and TLS details are written down.
# -----------------------------------------------------------------------------
data "aws_caller_identity" "current" {}

# eu-west-1 predates the service-principal delivery model, so log delivery is
# authorised by the regional Elastic Load Balancing account rather than by
# `logdelivery.elasticloadbalancing.amazonaws.com`. This data source resolves the
# right account per region instead of hardcoding 156460612806.
data "aws_elb_service_account" "main" {}

resource "aws_s3_bucket" "alb_logs" {
  # Bucket names are globally unique; the account id keeps this collision-free.
  bucket = "${var.project_name}-${var.environment}-alb-logs-${data.aws_caller_identity.current.account_id}"

  tags = {
    Name = "${var.project_name}-${var.environment}-alb-logs"
  }
}

resource "aws_s3_bucket_public_access_block" "alb_logs" {
  bucket                  = aws_s3_bucket.alb_logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "alb_logs" {
  bucket = aws_s3_bucket.alb_logs.id

  rule {
    apply_server_side_encryption_by_default {
      # ALB access-log delivery supports SSE-S3 only. A KMS CMK here does not fail
      # loudly — delivery just silently stops, which is the worst possible outcome
      # for the one component whose whole job is to keep a record.
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "alb_logs" {
  bucket = aws_s3_bucket.alb_logs.id

  rule {
    id     = "expire-old-logs"
    status = "Enabled"

    filter {}

    expiration {
      days = var.access_logs_retention_days
    }
  }
}

resource "aws_s3_bucket_policy" "alb_logs" {
  bucket = aws_s3_bucket.alb_logs.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowELBLogDelivery"
      Effect    = "Allow"
      Principal = { AWS = data.aws_elb_service_account.main.arn }
      Action    = "s3:PutObject"
      Resource  = "${aws_s3_bucket.alb_logs.arn}/AWSLogs/${data.aws_caller_identity.current.account_id}/*"
    }]
  })
}

# -----------------------------------------------------------------------------
# Application Load Balancer
# -----------------------------------------------------------------------------
resource "aws_lb" "main" {
  name               = "${var.project_name}-${var.environment}"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [var.alb_security_group_id]
  subnets            = var.public_subnet_ids

  access_logs {
    bucket  = aws_s3_bucket.alb_logs.id
    enabled = true
  }

  tags = {
    Name = "${var.project_name}-${var.environment}-alb"
  }

  # The bucket policy must exist before the ALB validates it can write, otherwise
  # enabling logs fails with an opaque "Access Denied for bucket" error.
  depends_on = [aws_s3_bucket_policy.alb_logs]
}

# -----------------------------------------------------------------------------
# Target Groups
# -----------------------------------------------------------------------------
resource "aws_lb_target_group" "paperclip" {
  name        = "${var.project_name}-${var.environment}-paperclip"
  port        = 3100
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip"

  health_check {
    path                = "/api/health"
    port                = "traffic-port"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    timeout             = 10
    interval            = 30
    matcher             = "200"
  }

  tags = {
    Name = "${var.project_name}-${var.environment}-paperclip-tg"
  }
}

resource "aws_lb_target_group" "mcp" {
  name        = "${var.project_name}-${var.environment}-mcp"
  port        = 3001
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip"

  health_check {
    path                = "/health"
    port                = "traffic-port"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    timeout             = 10
    interval            = 30
    matcher             = "200"
  }

  tags = {
    Name = "${var.project_name}-${var.environment}-mcp-tg"
  }
}

# -----------------------------------------------------------------------------
# HTTPS Listener (443) with host-based routing
# -----------------------------------------------------------------------------
resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.main.certificate_arn

  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      message_body = "Not Found"
      status_code  = "404"
    }
  }
}

resource "aws_lb_listener_rule" "paperclip" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 100

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.paperclip.arn
  }

  condition {
    host_header {
      values = [var.paperclip_domain]
    }
  }
}

resource "aws_lb_listener_rule" "mcp" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 200

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.mcp.arn
  }

  condition {
    host_header {
      values = [var.mcp_domain]
    }
  }
}

# -----------------------------------------------------------------------------
# HTTP Listener (80) — redirect to HTTPS
# -----------------------------------------------------------------------------
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}
