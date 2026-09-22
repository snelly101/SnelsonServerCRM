# syntax=docker/dockerfile:1
# Multi-stage build: the final image only contains the compiled app.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --ignore-scripts

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---- Web app (Next.js standalone) ----
FROM node:22-bookworm-slim AS web
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000
RUN groupadd -r app && useradd -r -g app app
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
COPY --from=build --chown=app:app /app/public ./public
USER app
EXPOSE 3000
CMD ["node", "server.js"]

# ---- Worker / tooling (migrations, seed, worker) ----
FROM node:22-bookworm-slim AS worker
WORKDIR /app
ENV NODE_ENV=production
RUN groupadd -r app && useradd -r -g app app
COPY --from=deps /app/node_modules ./node_modules
COPY --chown=app:app package.json tsconfig.json drizzle.config.ts ./
COPY --chown=app:app src ./src
COPY --chown=app:app drizzle ./drizzle
USER app
CMD ["npm", "run", "worker"]
