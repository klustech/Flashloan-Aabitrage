# Environment Setup

This project reads configuration from a `.env` file located in the repository root.
The helper `utils/config.js` automatically loads this file and exposes helper
functions `getEnv` and `loadRequired` used across the codebase. Any script can
simply import these helpers instead of calling `dotenv` directly.
