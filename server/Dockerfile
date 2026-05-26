FROM node:20-alpine

WORKDIR /usr/src/app

# Install production dependencies. Use a deterministic install when a lockfile
# is present in the build context (server/package-lock.json); fall back to a
# regular install otherwise.
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

COPY . .

ENV NODE_ENV=production
EXPOSE 3001

# Drop privileges: run as the built-in non-root "node" user.
USER node

# scripts/server.js boots the Express/WebSocket HTTP server (exposes /healthz,
# /metrics, /api/*) and internally requires ../botLogic to run the bot worker.
CMD ["node", "scripts/server.js"]
