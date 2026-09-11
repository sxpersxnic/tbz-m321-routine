# syntax=docker/dockerfile:1
# One Dockerfile for all Node services; the service is selected with --build-arg SERVICE=<name>.
# Every service still gets its own image and is deployed independently.

# ---- dependencies (identical layer for every service → built once, cached)
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY libs/service-kit/package.json libs/service-kit/
COPY services/gateway/package.json services/gateway/
COPY services/identity-service/package.json services/identity-service/
COPY services/routine-service/package.json services/routine-service/
COPY services/task-service/package.json services/task-service/
COPY services/notification-service/package.json services/notification-service/
COPY services/integration-worker/package.json services/integration-worker/
COPY services/mock-external/package.json services/mock-external/
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

# ---- runtime: Node 24 executes the TypeScript sources directly (type stripping, no build step)
FROM node:24-alpine
ARG SERVICE
ENV NODE_ENV=production \
    SERVICE=${SERVICE}
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY libs/service-kit ./libs/service-kit
COPY services/${SERVICE} ./services/${SERVICE}
USER node
EXPOSE 3000
CMD ["sh", "-c", "exec node --disable-warning=ExperimentalWarning --import @routine/service-kit/tracing services/${SERVICE}/src/main.ts"]
