# syntax=docker/dockerfile:1
# Mezmitra API. Build from the repo root:  docker build -f infra/docker/api.Dockerfile -t mezmitra-api .

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/print-agent/package.json apps/print-agent/
RUN npm ci --ignore-scripts

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN npm run build -w @mezmitra/api

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/print-agent/package.json apps/print-agent/
RUN npm ci --omit=dev --ignore-scripts -w @mezmitra/api && npm cache clean --force
COPY packages/shared packages/shared
COPY --from=build /app/apps/api/dist apps/api/dist
COPY apps/api/migrations apps/api/migrations
RUN mkdir -p apps/api/storage && chown -R node:node apps/api/storage
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s CMD wget -qO- http://127.0.0.1:4000/healthz || exit 1
CMD ["node", "apps/api/dist/server.js"]
