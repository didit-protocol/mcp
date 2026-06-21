# ------------------------------- Base node --------------------------------
FROM node:20-slim AS base

ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update && \
    apt-get install -y --no-install-recommends curl && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# node:20-slim already ships a non-root `node` user (uid/gid 1000) — reuse it.

# ---------------------------- Dependencies/build --------------------------
FROM base AS build

COPY package.json package-lock.json tsconfig.json ./
# Force devDependencies (typescript/tsc) even though NODE_ENV=production.
RUN npm ci --include=dev
COPY src src
RUN npm run build && npm prune --omit=dev

# ------------------------------- Production -------------------------------
FROM base AS prod

COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/dist /app/dist
COPY package.json ./

RUN chown -R node:node /app
USER node

ENV MCP_PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -fsS http://localhost:${MCP_PORT}/healthz || exit 1

CMD ["node", "dist/http.js"]
