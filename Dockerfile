# syntax=docker/dockerfile:1.27

FROM oven/bun:1.4.2 AS builder
WORKDIR /app

COPY package.json bun.lock tsconfig.json bunfig.toml LICENSE ./

RUN --mount=type=cache,target=/root/.bun/install/cache,sharing=locked \
	bun install --frozen-lockfile --ignore-scripts

COPY src ./src
COPY scripts/build.ts ./scripts/build.ts
COPY drizzle ./drizzle
RUN bun run build

FROM gcr.io/distroless/cc-debian12:nonroot AS runtime
LABEL org.opencontainers.image.title="Keyzori License Server" \
	org.opencontainers.image.description="Self-hosted software license management server" \
	org.opencontainers.image.licenses="Apache-2.0"
WORKDIR /app
ENV NODE_ENV=production \
	KEYZORI_SERVER_HOST=0.0.0.0 \
	KEYZORI_SERVER_PORT=3000 \
	PATH=/app

COPY --from=builder --chown=nonroot:nonroot /app/dist/ /app/

USER nonroot:nonroot

EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=5 \
	CMD ["/app/keyzori", "healthcheck"]

ENTRYPOINT ["/app/keyzori"]
CMD ["serve"]
STOPSIGNAL SIGTERM
