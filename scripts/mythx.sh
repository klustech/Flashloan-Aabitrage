#!/bin/bash
# scripts/mythx.sh - run MythX analysis
set -e
if ! command -v myth > /dev/null; then
  echo "MythX CLI not installed" >&2
  exit 1
fi
myth analyze contracts/ArbitrageFlashloan.sol -o json > mythx-report.json
