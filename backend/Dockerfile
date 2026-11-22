# Build context: repository root (so swagger.yaml is packaged alongside backend/)
FROM node:24-bookworm-slim

ENV NODE_ENV=production

WORKDIR /usr/src/app/backend

COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

COPY backend/ ./
COPY swagger.yaml /usr/src/app/swagger.yaml

EXPOSE 5000

USER node

CMD ["node", "server.js"]
