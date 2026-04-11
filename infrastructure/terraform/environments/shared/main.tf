# -----------------------------------------------------------------------------
# Shared Resources — ECR Repositories
# Created once, used by both staging and production
# -----------------------------------------------------------------------------
module "ecr" {
  source       = "../../modules/ecr"
  project_name = "gs-backoffice"
}
