# Traveler runs as one service: Bun serves the API and the built frontend from the
# same origin, with SQLite on a mounted volume.
FROM oven/bun:1.3-slim AS build
WORKDIR /app

# Manifests first so the dependency layer survives source-only changes.
COPY package.json bun.lock ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN bun install --frozen-lockfile

COPY . .
RUN bun run --cwd packages/web build

FROM oven/bun:1.3-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/packages/server ./packages/server
COPY --from=build /app/packages/web/dist ./packages/web/dist

# Overridden by Railway's PORT. Declared so `docker run -p` works locally.
ENV PORT=3000
EXPOSE 3000

# The default database path lives outside the image; point DATABASE_PATH at the volume.
ENV DATABASE_PATH=/data/traveler.db

WORKDIR /app/packages/server
CMD ["bun", "src/index.ts"]
