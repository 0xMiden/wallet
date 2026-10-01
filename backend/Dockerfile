FROM node:22.23.2-bookworm-slim AS development
WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --non-interactive
COPY tsconfig*.json ./
COPY src ./src
RUN mkdir /data && chown node:node /data /app
USER node
CMD ["node", "--import", "tsx", "--watch", "src/server.ts"]

FROM development AS build
RUN yarn build

FROM node:22.23.2-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --non-interactive --production=true && yarn cache clean

FROM node:22.23.2-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=8787 DB_PATH=/data/onramp.sqlite
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY --from=build /app/dist ./dist
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.PORT + '/health', {signal: AbortSignal.timeout(4000)}).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "dist/server.js"]
