terraform {
  backend "s3" {
    bucket         = "gs-backoffice-terraform-state"
    key            = "shared/terraform.tfstate"
    region         = "eu-west-1"
    dynamodb_table = "gs-backoffice-terraform-lock"
    encrypt        = true
  }
}
