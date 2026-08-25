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
# OIDC credentials
#
# Read from the app secret rather than a tfvar so there is a single source of
# truth and no extra GitHub secret. Be aware: an `authenticate-oidc` action stores
# the client secret in the listener rule, so it lands in Terraform state whatever
# the source — that is a property of the resource, not of this lookup. The state
# bucket is encrypted, and `random_password.db` is already there on the same terms.
# -----------------------------------------------------------------------------
data "aws_secretsmanager_secret_version" "app" {
  count     = var.paperclip_oidc_enabled ? 1 : 0
  secret_id = var.app_secrets_arn
}

locals {
  app_secrets        = var.paperclip_oidc_enabled ? jsondecode(data.aws_secretsmanager_secret_version.app[0].secret_string) : {}
  oidc_client_id     = try(local.app_secrets["OIDC_CLIENT_ID"], "")
  oidc_client_secret = try(local.app_secrets["OIDC_CLIENT_SECRET"], "")
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

# -----------------------------------------------------------------------------
# Board rule — authenticated at the edge
#
# Paperclip's board is an admin UI on an internet-facing ALB. Before this, every
# unauthenticated request reached the container: 221 WordPress probes in 29 days,
# `/.env`, `/.git/config`, and — the one that mattered — `POST /api/auth/sign-up/email`,
# through which scanners registered 17 accounts and minted 19 board API keys.
#
# Closing sign-up (#101) removed that particular door. This closes the corridor:
# an unauthenticated request is now answered by the load balancer itself and never
# reaches Paperclip at all. Paperclip's own login stays behind it, so the two are
# independent barriers.
#
# Note the division of labour: the ALB AUTHENTICATES, it does not AUTHORISE. It
# only proves the caller completed the OIDC flow — it cannot filter by group.
# Authorisation comes from which JumpCloud users the SSO application is assigned
# to. Assigning it to "All Users" would open the board to the whole directory.
#
# Deliberately NOT applied to the MCP rule (priority 200): Claude.ai talks to it
# over MCP, which cannot follow an interactive redirect.
# -----------------------------------------------------------------------------
resource "aws_lb_listener_rule" "paperclip" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 100

  dynamic "action" {
    for_each = var.paperclip_oidc_enabled ? [1] : []

    content {
      type  = "authenticate-oidc"
      order = 1

      authenticate_oidc {
        # Endpoints taken from https://oauth.id.jumpcloud.com/.well-known/openid-configuration.
        # JumpCloud advertises authorization_code + RS256 + an unsigned /userinfo,
        # which is exactly the subset the ALB can consume.
        issuer                 = "https://oauth.id.jumpcloud.com/"
        authorization_endpoint = "https://oauth.id.jumpcloud.com/oauth2/auth"
        token_endpoint         = "https://oauth.id.jumpcloud.com/oauth2/token"
        user_info_endpoint     = "https://oauth.id.jumpcloud.com/userinfo"

        client_id     = local.oidc_client_id
        client_secret = local.oidc_client_secret

        scope = "openid email profile"

        # Send the caller to JumpCloud rather than returning 401, so a human lands
        # on a login page and a scanner gets a redirect instead of the application.
        on_unauthenticated_request = "authenticate"

        # 8h: one working day, then re-authenticate. The ALB default is 7 days,
        # which is a long time for an admin session on an internet-facing host.
        session_timeout = 28800
      }
    }
  }

  action {
    type             = "forward"
    order            = var.paperclip_oidc_enabled ? 2 : 1
    target_group_arn = aws_lb_target_group.paperclip.arn
  }

  condition {
    host_header {
      values = [var.paperclip_domain]
    }
  }

  # Empty credentials would not fail — the ALB would simply redirect every visitor
  # to an identity provider that rejects them, locking the board for everyone with
  # no obvious cause. Fail at plan time instead.
  lifecycle {
    precondition {
      condition     = !var.paperclip_oidc_enabled || (local.oidc_client_id != "" && local.oidc_client_secret != "")
      error_message = "paperclip_oidc_enabled is true but OIDC_CLIENT_ID / OIDC_CLIENT_SECRET are missing from the app secret."
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
