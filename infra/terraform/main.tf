provider "aws" {
  region = "us-east-1"
}

resource "aws_instance" "arb_bot" {
  ami           = "ami-0123456789abcdef0" # Ubuntu 20.04 LTS
  instance_type = "t3.medium"
  user_data     = file("scripts/user_data.sh" )
  tags = {
    Name = "flashloan-arb-bot"
  }
}

resource "aws_security_group" "allow_http" {
  name        = "allow_http"
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
    cidr_blocks = ["0.0.0.0/0"]
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

