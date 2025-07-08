#!/bin/bash
# scripts/slither.sh - run Slither analysis
set -e
if ! command -v slither > /dev/null; then
  echo "Slither not installed" >&2
  exit 1
fi
slither ./contracts --json slither-report.json
