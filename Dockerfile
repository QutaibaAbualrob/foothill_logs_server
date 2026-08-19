# The shipped image: Fastify on Bun.
#
# Adopted 2026-08-18 on measured evidence. The deciding number was not ingest
# throughput but the read path under concurrent ingest: 19.6-21.7 drain pages/s
# against Express + Node's 0.96-1.09, and 99.6-99.8% of acknowledged rows
# visible inside a 30 s window against 14.5-15.3%. See
# docs/test_results/mixed-workload-baseline.md.
#
# There is no compile stage. Bun executes TypeScript directly, so the image runs
# src/index.ts rather than a dist/ build. Type checking has not been dropped --
# it moved out of the image into the `npm run typecheck` gate, which runs on
# Node with the same tsconfig and is therefore load-bearing rather than
# redundant. CI must keep running it.
FROM oven/bun:1.3.14-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts

FROM oven/bun:1.3.14-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json ./
# src/ is the runnable artifact here, not just the source of one. It also has to
# be present for migrate.ts, which reads src/db/migrations relative to cwd.
COPY src ./src
RUN chown -R bun:bun /app
USER bun
EXPOSE 8080
CMD ["bun", "run", "src/index.ts"]
