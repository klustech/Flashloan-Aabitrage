#!/usr/bin/env bash
# Install Docker, Node.js, PM2, PostgreSQL
apt-get update
apt-get install -y docker.io docker-compose postgresql postgresql-contrib
curl -sL https://deb.nodesource.com/setup_18.x | bash -
apt-get install -y nodejs
npm install -g pm2

# Clone repo & start services
git clone https://github.com/flashloan-arb/flashloan-arbitrage.git /home/ubuntu/flashloan-arb
cd /home/ubuntu/flashloan-arb
npm ci
docker-compose up -d
