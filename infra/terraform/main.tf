# ─────────────────────────────────────────────────────────────────────────────
# REMOTE STATE BACKEND
# ─────────────────────────────────────────────────────────────────────────────
# For team use / production, configure a remote backend so tfstate is not kept
# locally (local state risks loss and leaks secrets). Uncomment and fill in:
#
#   terraform {
#     backend "s3" {
#       bucket         = "my-tfstate-bucket"
#       key            = "flashloan-arb/terraform.tfstate"
#       region         = "us-east-1"
#       dynamodb_table = "terraform-locks"  # state locking
#       encrypt        = true
#     }
#   }
# ─────────────────────────────────────────────────────────────────────────────

provider "aws" {
  region = "us-east-1"
}

# ─── Variables ───────────────────────────────────────────────────────────────
variable "key_name" {
  description = "Name of an existing EC2 key pair to enable SSH access. Do not hardcode."
  type        = string
}

variable "ssh_allowed_cidr" {
  description = "CIDR allowed to reach SSH (port 22). OVERRIDE this with your own IP/range."
  type        = string
  # Placeholder: locked down by default. Override with e.g. "203.0.113.4/32".
  default = "127.0.0.1/32"
}

resource "aws_instance" "arb_bot" {
  # Ubuntu 20.04 LTS AMI for us-east-1 (update as needed)
  ami           = "ami-09e67e426f25ce0d7"
  instance_type = "t3.medium"
  user_data     = file("scripts/user_data.sh")
  key_name      = var.key_name

  # Attach the security group so its ingress/egress rules actually apply.
  vpc_security_group_ids = [aws_security_group.allow_http.id]

  tags = {
    Name = "flashloan-arb-bot"
  }
}

resource "aws_security_group" "allow_http" {
  name = "allow_http"

  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    # Restricted to an explicit CIDR instead of the whole internet.
    cidr_blocks = [var.ssh_allowed_cidr]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

output "public_ip" {
  value = aws_instance.arb_bot.public_ip
}
