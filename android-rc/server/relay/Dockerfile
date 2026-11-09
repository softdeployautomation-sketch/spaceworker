FROM node:20-slim
WORKDIR /srv
COPY package.json ./
RUN npm install --omit=dev
COPY . .
ENV NODE_ENV=production
CMD ["node", "relay/index.mjs"]