terraform {
  # Pinned to the minor the pipeline runs (see /.terraform-version). ">= 1.0" let a
  # local CLI three minor versions behind plan against this state: it reported five
  # resources as changing when 1.9.8 reports none. A plan that does not match what
  # will be applied is worse than no plan, so an out-of-range CLI must refuse to run
  # rather than mislead.
  required_version = "~> 1.9"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.0"
    }
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "gs-backoffice"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}
