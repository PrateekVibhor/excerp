# Build from the repo root (see docker-compose.yml): the server imports the app's src/data/types.ts.
FROM node:26-slim
ENV NODE_ENV=production
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
COPY src/data/types.ts /app/src/data/types.ts
COPY server/src ./src
USER node
CMD ["node", "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "src/api.ts"]
