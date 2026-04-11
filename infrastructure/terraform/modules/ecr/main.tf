# -----------------------------------------------------------------------------
# ECR Repositories (shared between staging and production)
# -----------------------------------------------------------------------------
resource "aws_ecr_repository" "paperclip" {
  name                 = "${var.project_name}-paperclip"
  image_tag_mutability = "MUTABLE"
  force_delete         = false

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = {
    Name = "${var.project_name}-paperclip"
  }
}

resource "aws_ecr_repository" "mcp" {
  name                 = "${var.project_name}-mcp"
  image_tag_mutability = "MUTABLE"
  force_delete         = false

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = {
    Name = "${var.project_name}-mcp"
  }
}

# Keep last 10 images per repo
resource "aws_ecr_lifecycle_policy" "paperclip" {
  repository = aws_ecr_repository.paperclip.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep last 10 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 10
      }
      action = {
        type = "expire"
      }
    }]
  })
}

resource "aws_ecr_lifecycle_policy" "mcp" {
  repository = aws_ecr_repository.mcp.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep last 10 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 10
      }
      action = {
        type = "expire"
      }
    }]
  })
}
