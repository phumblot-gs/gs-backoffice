# -----------------------------------------------------------------------------
# ECS Cluster
# -----------------------------------------------------------------------------
resource "aws_ecs_cluster" "main" {
  name = "${var.project_name}-${var.environment}"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = {
    Name = "${var.project_name}-${var.environment}-cluster"
  }
}

# -----------------------------------------------------------------------------
# CloudWatch Log Groups
# -----------------------------------------------------------------------------
resource "aws_cloudwatch_log_group" "paperclip" {
  name              = "/ecs/${var.project_name}-${var.environment}/paperclip"
  retention_in_days = 30
}

resource "aws_cloudwatch_log_group" "mcp" {
  name              = "/ecs/${var.project_name}-${var.environment}/mcp-server"
  retention_in_days = 30
}

# -----------------------------------------------------------------------------
# IAM — ECS Execution Role (pull images, read secrets, write logs)
# -----------------------------------------------------------------------------
data "aws_caller_identity" "current" {}

resource "aws_iam_role" "ecs_execution" {
  name = "${var.project_name}-${var.environment}-ecs-execution"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "ecs-tasks.amazonaws.com"
      }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_execution_base" {
  role       = aws_iam_role.ecs_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "ecs_execution_secrets" {
  name = "secrets-access"
  role = aws_iam_role.ecs_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "secretsmanager:GetSecretValue"
      ]
      Resource = [
        var.db_secret_arn,
        var.app_secrets_arn
      ]
    }]
  })
}

# -----------------------------------------------------------------------------
# IAM — ECS Task Role (app-level permissions)
# -----------------------------------------------------------------------------
resource "aws_iam_role" "ecs_task" {
  name = "${var.project_name}-${var.environment}-ecs-task"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "ecs-tasks.amazonaws.com"
      }
    }]
  })
}

resource "aws_iam_role_policy" "ecs_task_secrets" {
  name = "secrets-access"
  role = aws_iam_role.ecs_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue"
        ]
        Resource = [
          var.app_secrets_arn
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "ssmmessages:CreateControlChannel",
          "ssmmessages:CreateDataChannel",
          "ssmmessages:OpenControlChannel",
          "ssmmessages:OpenDataChannel"
        ]
        Resource = ["*"]
      }
    ]
  })
}

# -----------------------------------------------------------------------------
# Task Definition — Paperclip
# -----------------------------------------------------------------------------
resource "aws_ecs_task_definition" "paperclip" {
  family                   = "${var.project_name}-${var.environment}-paperclip"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.paperclip_cpu
  memory                   = var.paperclip_memory
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([{
    name  = "paperclip"
    image = "${var.ecr_paperclip_url}:${var.image_tag}"
    portMappings = [{
      containerPort = 3100
      protocol      = "tcp"
    }]
    environment = [
      { name = "PORT", value = "3100" },
      { name = "SERVE_UI", value = "true" },
      { name = "NODE_ENV", value = var.environment },
      { name = "PAPERCLIP_TELEMETRY_DISABLED", value = "1" },
      { name = "PAPERCLIP_ALLOWED_HOSTNAMES", value = var.paperclip_allowed_hostnames },
      { name = "PAPERCLIP_PUBLIC_URL", value = var.paperclip_public_url },
    ]
    secrets = [
      {
        name      = "DATABASE_URL"
        valueFrom = "${var.db_secret_arn}:url::"
      },
      {
        name      = "BETTER_AUTH_SECRET"
        valueFrom = "${var.app_secrets_arn}:BETTER_AUTH_SECRET::"
      },
      {
        name      = "ANTHROPIC_API_KEY"
        valueFrom = "${var.app_secrets_arn}:ANTHROPIC_API_KEY::"
      },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.paperclip.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "ecs"
      }
    }
    essential = true
  }])
}

# -----------------------------------------------------------------------------
# Task Definition — MCP Server
# -----------------------------------------------------------------------------
resource "aws_ecs_task_definition" "mcp" {
  family                   = "${var.project_name}-${var.environment}-mcp"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.mcp_cpu
  memory                   = var.mcp_memory
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([{
    name  = "mcp-server"
    image = "${var.ecr_mcp_url}:${var.image_tag}"
    portMappings = [{
      containerPort = 3001
      protocol      = "tcp"
    }]
    environment = [
      { name = "MCP_SERVER_PORT", value = "3001" },
      { name = "NODE_ENV", value = var.environment },
    ]
    secrets = [
      {
        name      = "PAPERCLIP_API_URL"
        valueFrom = "${var.app_secrets_arn}:PAPERCLIP_API_URL::"
      },
      {
        name      = "PAPERCLIP_API_KEY"
        valueFrom = "${var.app_secrets_arn}:PAPERCLIP_API_KEY::"
      },
      {
        name      = "PAPERCLIP_COMPANY_ID"
        valueFrom = "${var.app_secrets_arn}:PAPERCLIP_COMPANY_ID::"
      },
      {
        name      = "CHIEF_OF_STAFF_AGENT_ID"
        valueFrom = "${var.app_secrets_arn}:CHIEF_OF_STAFF_AGENT_ID::"
      },
      {
        name      = "EVT_API_URL"
        valueFrom = "${var.app_secrets_arn}:EVT_API_URL::"
      },
      {
        name      = "EVT_API_KEY"
        valueFrom = "${var.app_secrets_arn}:EVT_API_KEY::"
      },
      {
        name      = "JUMPCLOUD_API_KEY"
        valueFrom = "${var.app_secrets_arn}:JUMPCLOUD_API_KEY::"
      },
      {
        name      = "JUMPCLOUD_ORG_ID"
        valueFrom = "${var.app_secrets_arn}:JUMPCLOUD_ORG_ID::"
      },
      {
        name      = "NOTION_API_TOKEN"
        valueFrom = "${var.app_secrets_arn}:NOTION_API_TOKEN::"
      },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.mcp.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "ecs"
      }
    }
    essential = true
  }])
}

# -----------------------------------------------------------------------------
# ECS Services
# -----------------------------------------------------------------------------
resource "aws_ecs_service" "paperclip" {
  name            = "paperclip"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.paperclip.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  enable_execute_command = true

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [var.ecs_security_group_id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = var.paperclip_target_group_arn
    container_name   = "paperclip"
    container_port   = 3100
  }

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
}

resource "aws_ecs_service" "mcp" {
  name            = "mcp-server"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.mcp.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [var.ecs_security_group_id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = var.mcp_target_group_arn
    container_name   = "mcp-server"
    container_port   = 3001
  }

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
}
