FROM node:16-alpine

WORKDIR /usr/src/ml
COPY mlScorer.js package.json yarn.lock ./
RUN yarn install --production

COPY ml/lightgbm_model.txt ./ml/lightgbm_model.txt

ENV NODE_ENV=production
EXPOSE 3002

CMD ["node", "mlScorer.js"]
