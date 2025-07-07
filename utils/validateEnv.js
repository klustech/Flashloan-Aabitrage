"use strict";

function validateEnv(required) {
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    const msg = `Missing required environment variables: ${missing.join(", ")}`;
    throw new Error(msg);
  }
}

module.exports = { validateEnv };
