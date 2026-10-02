FROM node:22-alpine
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts --legacy-peer-deps
COPY server ./server
RUN cd server && npm ci --omit=dev --ignore-scripts --legacy-peer-deps
COPY utils ./utils
COPY scripts ./scripts
COPY database ./database
RUN mkdir runtime && chown node:node runtime
ENV NODE_ENV=production
ENV API_BIND_HOST=0.0.0.0
EXPOSE 3001
USER node
CMD ["node", "server/scripts/server.js"]
