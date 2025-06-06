#!/usr/bin/env bash
set -e

NETWORK=$1
if [ -z "$NETWORK" ]; then
  echo "Usage: ./deployAll.sh <network>"
  exit 1
fi

npx hardhat run scripts/deploy.js --network $NETWORK
