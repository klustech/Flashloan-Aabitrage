# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /usr/src/app

# Deterministic install when a lockfile exists in the build context, else fall back.
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY . .

# Drop privileges for the build itself (the "node" user ships with the image).
USER node
RUN npm run build

# ── Runtime stage ───────────────────────────────────────────────────────────────
# Serve the static build with nginx. The nginx master needs root to bind :80,
# but its worker processes automatically drop to the unprivileged "nginx" user.
FROM nginx:stable-alpine
COPY --from=build /usr/src/app/build /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
