#!/bin/bash
# Install required packages for Hardhat tests when npm install fails to pull optional deps
set -e
npm install ws@8.11.0 elliptic@6.5.4 color-name@1.1.4 solc@0.8.20
