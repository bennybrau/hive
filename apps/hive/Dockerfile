FROM node:24-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/hive/package.json apps/hive/
COPY apps/dashboard/package.json apps/dashboard/
RUN pnpm install --frozen-lockfile --filter hive --filter dashboard
COPY apps/hive apps/hive
COPY apps/dashboard apps/dashboard
RUN pnpm --filter hive build && pnpm --filter dashboard build && pnpm --filter hive --prod deploy --legacy /out

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
# The dashboard, served at / (HIVE_DASHBOARD_DIR defaults here).
COPY --from=build /app/apps/dashboard/dist ./public
COPY apps/hive/migrations ./migrations
USER node
EXPOSE 8800
# Healthy once /health answers OK (published images carry this; compose needn't repeat it).
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.HIVE_PORT||8800)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist/index.js"]
