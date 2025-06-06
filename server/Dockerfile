FROM node:16-alpine

WORKDIR /usr/src/app
COPY package.json yarn.lock ./
RUN yarn install --production

COPY . .

ENV NODE_ENV=production
EXPOSE 3001

CMD ["node", "botLogic.js"]
