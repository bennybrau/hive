FROM node:24-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile --filter worker
COPY apps/worker apps/worker
RUN pnpm --filter worker build

FROM node:24-slim
# Pinned: the worker relies on `claude -p --output-format json` and `claude auth status --json`. Bump deliberately.
ARG CLAUDE_CODE_VERSION=2.1.284
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm i -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
 && npm cache clean --force
# The lean flags ClaudeRunner passes (CLAUDE_LEAN_FLAGS and --system-prompt): fail the build if this claude lacks one.
RUN claude --help > /tmp/claude-help \
 && for f in --tools --strict-mcp-config --setting-sources --system-prompt; do \
      grep -qE -- "^ +$f " /tmp/claude-help || { echo "claude ${CLAUDE_CODE_VERSION} lacks $f" >&2; exit 1; }; \
    done \
 && rm /tmp/claude-help
WORKDIR /app
ENV NODE_ENV=production DISABLE_AUTOUPDATER=1
# No runtime dependencies: the worker uses only Node's fetch and child_process.
COPY apps/worker/package.json ./
COPY --from=build /app/apps/worker/dist ./dist
COPY apps/worker/prompts ./prompts
USER node
CMD ["node", "dist/index.js"]
