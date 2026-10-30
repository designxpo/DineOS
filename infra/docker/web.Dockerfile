# syntax=docker/dockerfile:1
# Mezvaan web (guest PWA, staff portal, admin). Build from the repo root:
#   docker build -f infra/docker/web.Dockerfile --build-arg NEXT_PUBLIC_API_URL=https://api.example.com -t mezmitra-web .

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/print-agent/package.json apps/print-agent/
RUN npm ci --ignore-scripts

FROM deps AS build
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL NEXT_TELEMETRY_DISABLED=1
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
# Fonts are downloaded here (build time) and served from our own origin at runtime.
RUN npm run build -w @mezmitra/web

FROM node:24-alpine AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /app/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
