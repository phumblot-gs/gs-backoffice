# -----------------------------------------------------------------------------
# NETWORKING
# -----------------------------------------------------------------------------
module "networking" {
  source = "../../modules/networking"

  environment  = var.environment
  project_name = var.project_name
}

# -----------------------------------------------------------------------------
# DATABASE — RDS PostgreSQL 16
# -----------------------------------------------------------------------------
module "database" {
  source = "../../modules/database"

  environment  = var.environment
  project_name = var.project_name

  vpc_id                = module.networking.vpc_id
  private_subnet_ids    = module.networking.private_subnet_ids
  rds_security_group_id = module.networking.rds_security_group_id

  instance_class          = var.db_instance_class
  deletion_protection     = true
  skip_final_snapshot     = false
  backup_retention_period = 14
}

# -----------------------------------------------------------------------------
# SECRETS
# -----------------------------------------------------------------------------
module "secrets" {
  source = "../../modules/secrets"

  environment  = var.environment
  project_name = var.project_name
}

# -----------------------------------------------------------------------------
# LOAD BALANCER
# -----------------------------------------------------------------------------
module "load_balancer" {
  source = "../../modules/load-balancer"

  environment  = var.environment
  project_name = var.project_name

  vpc_id                = module.networking.vpc_id
  public_subnet_ids     = module.networking.public_subnet_ids
  alb_security_group_id = module.networking.alb_security_group_id

  paperclip_domain = var.paperclip_domain
  mcp_domain       = var.mcp_domain
}

# -----------------------------------------------------------------------------
# COMPUTE — ECS Fargate
# -----------------------------------------------------------------------------
module "compute" {
  source = "../../modules/compute"

  environment  = var.environment
  project_name = var.project_name
  aws_region   = var.aws_region

  private_subnet_ids    = module.networking.private_subnet_ids
  ecs_security_group_id = module.networking.ecs_security_group_id

  paperclip_target_group_arn = module.load_balancer.paperclip_target_group_arn
  mcp_target_group_arn       = module.load_balancer.mcp_target_group_arn

  ecr_paperclip_url = var.ecr_paperclip_url
  ecr_mcp_url       = var.ecr_mcp_url
  image_tag         = var.image_tag

  db_secret_arn   = module.database.db_secret_arn
  app_secrets_arn = module.secrets.app_secrets_arn

  paperclip_cpu               = var.paperclip_cpu
  paperclip_memory            = var.paperclip_memory
  paperclip_allowed_hostnames = "${var.paperclip_domain},${var.mcp_domain}"
  paperclip_public_url        = "https://${var.paperclip_domain}"
  mcp_cpu                     = var.mcp_cpu
  mcp_memory                  = var.mcp_memory
}

# -----------------------------------------------------------------------------
# MONITORING
# -----------------------------------------------------------------------------
module "monitoring" {
  source = "../../modules/monitoring"

  environment  = var.environment
  project_name = var.project_name
  aws_region   = var.aws_region

  ecs_cluster_name       = module.compute.ecs_cluster_name
  paperclip_service_name = module.compute.paperclip_service_name
  mcp_service_name       = module.compute.mcp_service_name
  db_instance_identifier = module.database.db_instance_identifier
  alb_arn_suffix         = module.load_balancer.alb_arn_suffix
  alert_email            = var.alert_email
}
