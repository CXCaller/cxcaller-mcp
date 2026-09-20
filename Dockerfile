# syntax=docker/dockerfile:1

FROM node:22-alpine AS build
WORKDIR /app
RUN npm install -g pnpm@12.4.2

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

# Hosted mode: the HTTP transport, every caller bringing their own API key.
# Per-deployment settings (CXCALLER_API_URL, CXCALLER_MCP_ALLOWED_HOSTS, ...)
# come from the Helm chart in cxcaller-infra, not from this image.
USER node
EXPOSE 8080
CMD ["node", "dist/cli.js", "--http", "--host", "0.0.0.0"]
