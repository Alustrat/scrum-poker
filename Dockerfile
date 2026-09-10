FROM node:24-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
COPY client/package.json client/package.json
COPY server/package.json server/package.json
RUN npm install

COPY . .
RUN npm run build

ENV NODE_ENV=production

EXPOSE 3001
CMD ["node", "server/dist/index.js"]
