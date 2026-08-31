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
# -----------------------------------------------------------------------------
# Service discovery (east-west traffic)
#
# The MCP server needs to call the Paperclip API. Until now the only address it
# had was the PUBLIC hostname, so every internal call left the private subnet
# through the NAT gateway, crossed the internet, and came back in via the ALB's
# public IPs — for two tasks in the same subnet. That detour already cost us once:
# the agent bridge had to hardcode a loopback override because long-running tools
# were being killed by the ALB's 60s idle cap (see apps/agent-sandbox-mcp/src/proxy.ts).
#
# It also made the board impossible to put behind edge authentication: an OIDC
# action on the listener rule would have answered those internal API calls with a
# redirect to the identity provider, which no MCP client can follow.
#
# A private DNS namespace gives Paperclip an internal name resolving to the task
# ENI, so internal traffic stays inside the VPC.
# -----------------------------------------------------------------------------
resource "aws_service_discovery_private_dns_namespace" "internal" {
  name        = "${var.project_name}-${var.environment}.local"
  description = "Internal service discovery for ${var.project_name} ${var.environment}"
  vpc         = var.vpc_id
}

resource "aws_service_discovery_service" "paperclip" {
  name = "paperclip"

  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.internal.id

    dns_records {
      # Short TTL: with awsvpc networking the record holds the task ENI IP, which
      # changes on every deployment.
      ttl  = 10
      type = "A"
    }

    routing_policy = "MULTIVALUE"
  }

  # ECS manages instance registration/deregistration for us.
  health_check_custom_config {
    failure_threshold = 1
  }
}

resource "aws_cloudwatch_log_group" "paperclip" {
  name              = "/ecs/${var.project_name}-${var.environment}/paperclip"
  retention_in_days = 30
}

resource "aws_cloudwatch_log_group" "mcp" {
  name              = "/ecs/${var.project_name}-${var.environment}/mcp-server"
  retention_in_days = 30
}

resource "aws_cloudwatch_log_group" "notify" {
  name              = "/ecs/${var.project_name}-${var.environment}/notify-consumer"
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
        # Bootstrap secrets: the single JSON document Terraform injects into the task
        # definition. Read once at container start, before Paperclip can resolve anything.
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue"
        ]
        Resource = [
          var.app_secrets_arn
        ]
      },
      {
        # Paperclip's own secret store. 2026.824.1 ships an AWS Secrets Manager provider
        # that MANAGES secrets rather than reading ours: one AWS secret per value, named
        # under a prefix. Pointing Paperclip at it is what lets plugin config and agent
        # env hold secret REFERENCES instead of values — which in turn retires the
        # ADAPTER_ENV_PASSTHROUGH patch and stops agent secrets being stored in clear.
        #
        # Scoped to the prefix: this role can never touch the bootstrap secret above,
        # nor anything else in the account. ListSecrets has no resource-level form, so
        # it is granted separately below and only exposes names and metadata.
        Effect = "Allow"
        Action = [
          "secretsmanager:CreateSecret",
          "secretsmanager:PutSecretValue",
          "secretsmanager:GetSecretValue",
          "secretsmanager:DescribeSecret",
          "secretsmanager:DeleteSecret",
          "secretsmanager:TagResource"
        ]
        Resource = [
          # Secrets Paperclip creates itself (managedMode = paperclip_managed).
          "arn:aws:secretsmanager:${var.aws_region}:${data.aws_caller_identity.current.account_id}:secret:${var.paperclip_secret_prefix}/*",
          # Secrets WE own in Terraform and Paperclip only reads
          # (managedMode = external_reference). Read-only in practice: Paperclip has
          # no reason to write here, but the actions are shared with the block above.
          "arn:aws:secretsmanager:${var.aws_region}:${data.aws_caller_identity.current.account_id}:secret:${var.paperclip_resolved_secret_path}/*"
        ]
      },
      {
        # ListSecrets does not support resource-level permissions. It returns names,
        # tags and metadata — never values — so the blast radius is disclosure of which
        # secrets exist, not of what they contain.
        Effect = "Allow"
        Action = [
          "secretsmanager:ListSecrets"
        ]
        Resource = ["*"]
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
      # The ALB is internet-facing: keep public account creation closed (see the variable).
      { name = "PAPERCLIP_DISABLE_SIGNUP", value = tostring(var.paperclip_disable_signup) },
      # Paperclip's own plugin workers (budget jobs, PR-review digest) call the API
      # from inside this container, so the right address is loopback — never the
      # public hostname, which would leave the VPC to come straight back.
      { name = "PAPERCLIP_API_URL", value = "http://localhost:3100" },
      # Repo the self-evolution bridge operates on, when the agent omits repoUrl. Read by
      # the bridge as a fallback — NOT bound to a Paperclip workspace, which would make the
      # host attempt a git clone each run (we keep all code execution in the Fly sandbox).
      { name = "BACKOFFICE_REPO_URL", value = var.backoffice_repo_url },
      # Company whose plugin config the scheduled jobs read. A job carries no company
      # to derive, so without this the reaper and the PR-review digest read an empty
      # config and silently ignore every secret reference. See the variable.
      { name = "PAPERCLIP_COMPANY_ID", value = var.paperclip_company_id },
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
      {
        name      = "SPRITES_TOKEN"
        valueFrom = "${var.app_secrets_arn}:SPRITES_TOKEN::"
      },
      {
        # GitHub token for the sandbox tools (clone/push from inside a Sprite),
        # used when no read/push split is configured. Forwarded to the plugin
        # worker via the ADAPTER_ENV_PASSTHROUGH patch.
        name      = "SANDBOX_GITHUB_TOKEN"
        valueFrom = "${var.app_secrets_arn}:SANDBOX_GITHUB_TOKEN::"
      },
      {
        # Read-only GitHub token for verification (sandbox_run). Least privilege.
        name      = "SANDBOX_GITHUB_READ_TOKEN"
        valueFrom = "${var.app_secrets_arn}:SANDBOX_GITHUB_READ_TOKEN::"
      },
      {
        # Push-capable GitHub token for sandbox_code_task.
        name      = "SANDBOX_GITHUB_PUSH_TOKEN"
        valueFrom = "${var.app_secrets_arn}:SANDBOX_GITHUB_PUSH_TOKEN::"
      },
      # GitHub App "GRAFMAKER Henri" — the bridge mints short-lived installation tokens
      # so PRs are authored by the bot (author != the human approver, SOC2 CC8). The
      # bridge inherits this container env. Absent/placeholder → falls back to the PATs.
      {
        name      = "GITHUB_APP_ID"
        valueFrom = "${var.app_secrets_arn}:GITHUB_APP_ID::"
      },
      {
        name      = "GITHUB_APP_INSTALLATION_ID"
        valueFrom = "${var.app_secrets_arn}:GITHUB_APP_INSTALLATION_ID::"
      },
      {
        name      = "GITHUB_APP_PRIVATE_KEY"
        valueFrom = "${var.app_secrets_arn}:GITHUB_APP_PRIVATE_KEY::"
      },
      {
        name      = "PAPERCLIP_SECRETS_MASTER_KEY"
        valueFrom = "${var.app_secrets_arn}:PAPERCLIP_SECRETS_MASTER_KEY::"
      },
      # EVT — so agent-run subprocesses (the sandbox MCP bridge: PR-review notify) and
      # the sandbox plugin worker (PR-review digest job) can publish backoffice.notify.*
      # events. The bridge inherits this container env; the plugin worker gets it via
      # the ADAPTER_ENV_PASSTHROUGH patch.
      {
        name      = "EVT_API_URL"
        valueFrom = "${var.app_secrets_arn}:EVT_API_URL::"
      },
      {
        name      = "EVT_API_KEY"
        valueFrom = "${var.app_secrets_arn}:EVT_API_KEY::"
      },
      {
        name      = "EVT_ACCOUNT_ID"
        valueFrom = "${var.app_secrets_arn}:EVT_ACCOUNT_ID::"
      },
      # Native budget API (GRA-42 Step 2): the budget plugin worker reads budgets/overview
      # over loopback. Mirrors the mcp-server container + the ADAPTER_ENV_PASSTHROUGH patch.
      {
        name      = "PAPERCLIP_API_KEY"
        valueFrom = "${var.app_secrets_arn}:PAPERCLIP_API_KEY::"
      },
      {
        name      = "PAPERCLIP_COMPANY_ID"
        valueFrom = "${var.app_secrets_arn}:PAPERCLIP_COMPANY_ID::"
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
      # Reach Paperclip over the private DNS namespace, not the public hostname.
      {
        name  = "PAPERCLIP_API_URL"
        value = "http://${aws_service_discovery_service.paperclip.name}.${aws_service_discovery_private_dns_namespace.internal.name}:3100"
      },
    ]
    secrets = [
      {
        name      = "DATABASE_URL"
        valueFrom = "${var.db_secret_arn}:url::"
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
        name      = "EVT_ACCOUNT_ID"
        valueFrom = "${var.app_secrets_arn}:EVT_ACCOUNT_ID::"
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
      {
        name      = "GOOGLE_CLIENT_ID"
        valueFrom = "${var.app_secrets_arn}:GOOGLE_CLIENT_ID::"
      },
      {
        name      = "GOOGLE_CLIENT_SECRET"
        valueFrom = "${var.app_secrets_arn}:GOOGLE_CLIENT_SECRET::"
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
# Task Definition — Notify Consumer (EVT → Google Chat). Reuses the MCP image
# (same monorepo build) with a command override; no inbound port / no ALB.
# -----------------------------------------------------------------------------
resource "aws_ecs_task_definition" "notify" {
  family                   = "${var.project_name}-${var.environment}-notify"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.notify_cpu
  memory                   = var.notify_memory
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([{
    name    = "notify-consumer"
    image   = "${var.ecr_mcp_url}:${var.image_tag}"
    command = ["node", "apps/notify-consumer/dist/index.js"]
    environment = [
      { name = "NODE_ENV", value = var.environment },
    ]
    secrets = [
      {
        name      = "EVT_API_URL"
        valueFrom = "${var.app_secrets_arn}:EVT_API_URL::"
      },
      {
        name      = "EVT_API_KEY"
        valueFrom = "${var.app_secrets_arn}:EVT_API_KEY::"
      },
      {
        name      = "GOOGLE_CHAT_WEBHOOKS"
        valueFrom = "${var.app_secrets_arn}:GOOGLE_CHAT_WEBHOOKS::"
      },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.notify.name
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

  # Publishes the task ENI as paperclip.<project>-<env>.local for in-VPC callers.
  service_registries {
    registry_arn = aws_service_discovery_service.paperclip.arn
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

resource "aws_ecs_service" "notify" {
  name            = "notify-consumer"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.notify.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [var.ecs_security_group_id]
    assign_public_ip = false
  }

  # Worker — no inbound traffic, so no load balancer. A brief gap on redeploy is
  # acceptable for notifications (the consumer re-establishes its cursor at "now").
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100
}
