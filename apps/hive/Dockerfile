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
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./
COPY --from=build /app/apps/hive/dist ./dist
COPY apps/hive/migrations ./migrations
USER node
EXPOSE 8800
CMD ["node", "dist/index.js"]
