# Paperclip 2026.824.1 supports native S3 mirroring of agent run logs. The local
# Fargate filesystem is only a live buffer; completed logs must survive task rolls.
resource "aws_s3_bucket" "paperclip_run_logs" {
  bucket        = "${var.project_name}-${var.environment}-run-logs-${data.aws_caller_identity.current.account_id}"
  force_destroy = false
}

resource "aws_s3_bucket_public_access_block" "paperclip_run_logs" {
  bucket                  = aws_s3_bucket.paperclip_run_logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "paperclip_run_logs" {
  bucket = aws_s3_bucket.paperclip_run_logs.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "paperclip_run_logs" {
  bucket = aws_s3_bucket.paperclip_run_logs.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "paperclip_run_logs" {
  bucket = aws_s3_bucket.paperclip_run_logs.id
  versioning_configuration {
    status = "Enabled"
  }
}

# Retain current logs indefinitely until an audit retention policy is agreed.
# In-flight snapshots create old versions; only those expire after 30 days.
resource "aws_s3_bucket_lifecycle_configuration" "paperclip_run_logs" {
  bucket = aws_s3_bucket.paperclip_run_logs.id
  rule {
    id     = "expire-old-snapshots"
    status = "Enabled"
    filter {
      prefix = "run-logs/"
    }
    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }
  depends_on = [aws_s3_bucket_versioning.paperclip_run_logs]
}

resource "aws_s3_bucket_policy" "paperclip_run_logs" {
  bucket = aws_s3_bucket.paperclip_run_logs.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.paperclip_run_logs.arn, "${aws_s3_bucket.paperclip_run_logs.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}

# This stack currently shares the ECS task role between its three services.
# Limit access to the run-log prefix; no delete, ACL or public access permission.
resource "aws_iam_role_policy" "paperclip_run_logs" {
  name = "${var.project_name}-${var.environment}-paperclip-run-logs"
  role = aws_iam_role.ecs_task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject"]
        Resource = "${aws_s3_bucket.paperclip_run_logs.arn}/run-logs/*"
      },
      {
        # HeadObject must distinguish a missing log (404) from forbidden (403).
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = aws_s3_bucket.paperclip_run_logs.arn
      },
    ]
  })
}
