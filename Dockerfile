FROM oven/bun:1.4.2-alpine AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile --ignore-scripts
COPY plugins ./plugins
COPY scripts/plugins.ts ./scripts/plugins.ts
RUN bun scripts/plugins.ts install --production
# Elysia/OpenAPI peers install the compiler; schema-based docs do not use it.
# Prune in the dependency stage so these bytes never enter the runtime image.
RUN rm -rf /app/node_modules/typescript /app/node_modules/@typescript /app/node_modules/.bin/tsc

FROM oven/bun:1.4.2-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=dependencies --chown=bun:bun /app/node_modules ./node_modules
COPY --from=dependencies --chown=bun:bun /app/plugins ./plugins
COPY --chown=bun:bun src ./src
COPY --chown=bun:bun migrations ./migrations
COPY --chown=bun:bun package.json ./package.json
COPY --chown=bun:bun LICENSE ./LICENSE
USER bun
EXPOSE 6284
HEALTHCHECK --interval=15s --timeout=6s --start-period=60s CMD wget -q -T 5 -O /dev/null http://127.0.0.1:6284/ready || exit 1
ENTRYPOINT ["bun", "src/main.ts"]
CMD ["serve"]
