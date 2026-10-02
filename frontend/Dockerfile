FROM node:22-alpine AS build
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm ci --ignore-scripts --legacy-peer-deps
COPY . .
ENV REACT_APP_PRIVATE_DASHBOARD=true
RUN npm run build
FROM node:22-alpine
WORKDIR /usr/src/app
COPY --from=build /usr/src/app/build ./build
COPY server.js ./server.js
ENV NODE_ENV=production
ENV DASHBOARD_BIND_HOST=0.0.0.0
EXPOSE 3002
USER node
CMD ["node","server.js"]
