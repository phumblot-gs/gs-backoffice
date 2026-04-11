# -----------------------------------------------------------------------------
# DB Subnet Group
# -----------------------------------------------------------------------------
resource "aws_db_subnet_group" "main" {
  name       = "${var.project_name}-${var.environment}-db-subnet"
  subnet_ids = var.private_subnet_ids

  tags = {
    Name = "${var.project_name}-${var.environment}-db-subnet"
  }
}

# -----------------------------------------------------------------------------
# Random password for DB
# -----------------------------------------------------------------------------
resource "random_password" "db" {
  length  = 32
  special = false
}

# -----------------------------------------------------------------------------
# Secrets Manager — DB credentials
# -----------------------------------------------------------------------------
resource "aws_secretsmanager_secret" "db" {
  name                    = "${var.project_name}/${var.environment}/db-credentials"
  recovery_window_in_days = var.environment == "production" ? 30 : 0
}

resource "aws_secretsmanager_secret_version" "db" {
  secret_id = aws_secretsmanager_secret.db.id
  secret_string = jsonencode({
    username = "paperclip"
    password = random_password.db.result
    host     = aws_db_instance.main.address
    port     = 5432
    dbname   = "paperclip"
    url      = "postgresql://paperclip:${random_password.db.result}@${aws_db_instance.main.address}:5432/paperclip"
  })
}

# -----------------------------------------------------------------------------
# RDS PostgreSQL Instance
# -----------------------------------------------------------------------------
resource "aws_db_instance" "main" {
  identifier = "${var.project_name}-${var.environment}"

  engine         = "postgres"
  engine_version = var.engine_version
  instance_class = var.instance_class

  allocated_storage = var.allocated_storage
  storage_type      = "gp3"
  storage_encrypted = true

  db_name  = "paperclip"
  username = "paperclip"
  password = random_password.db.result

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [var.rds_security_group_id]

  multi_az            = false
  publicly_accessible = false

  backup_retention_period   = var.backup_retention_period
  deletion_protection       = var.deletion_protection
  skip_final_snapshot       = var.skip_final_snapshot
  final_snapshot_identifier = var.skip_final_snapshot ? null : "${var.project_name}-${var.environment}-final"

  tags = {
    Name = "${var.project_name}-${var.environment}-db"
  }
}
