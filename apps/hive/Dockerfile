FROM node:24-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/hive/package.json apps/hive/
RUN pnpm install --frozen-lockfile --filter hive
COPY apps/hive apps/hive
RUN pnpm --filter hive build && pnpm --filter hive --prod deploy --legacy /out

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
# git: read registered repos (files, blobs, log). poppler-utils: pdftotext for PDF docs.
# Repos are bind-mounted and owned by the host user, so tell git that's fine.
RUN apt-get update && apt-get install -y --no-install-recommends git poppler-utils ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && git config --system --add safe.directory '*'

COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./
COPY --from=build /app/apps/hive/dist ./dist
COPY apps/hive/migrations ./migrations
USER node
EXPOSE 8800
CMD ["node", "dist/index.js"]
