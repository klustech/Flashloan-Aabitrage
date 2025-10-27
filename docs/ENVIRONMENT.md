# Environment Setup

This project reads configuration from a `.env` file located in the repository
root. The helper `utils/config.js` automatically loads this file and exposes
helper functions `getEnv` and `loadRequired` used across shared scripts. Server
processes use `server/utils/runtimeConfig.js`, which additionally provides
typed accessors and feature flags so optional integrations (Balancer, Curve,
reinforcement-learning, etc.) can log warnings instead of crashing when their
environment variables are absent.
