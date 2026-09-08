# syntax=docker/dockerfile:1.27

FROM oven/bun:1.4.2 AS builder
WORKDIR /app

COPY package.json bun.lock tsconfig.json bunfig.toml LICENSE NOTICE ./
COPY apps/server/package.json ./apps/server/
COPY apps/sdk/package.json ./apps/sdk/

RUN --mount=type=cache,target=/root/.bun/install/cache,sharing=locked \
	bun install --frozen-lockfile --ignore-scripts

COPY apps/server ./apps/server
RUN bun run --cwd apps/server build

FROM gcr.io/distroless/cc-debian12:nonroot@sha256:9dac0a79194e45a7da0158a9c6da57b217585af0786db3845d1f0ec1a0dd182f AS runtime
LABEL org.opencontainers.image.title="Keyzori License Server" \
	org.opencontainers.image.description="Self-hosted software license management server" \
	org.opencontainers.image.licenses="Apache-2.0"
WORKDIR /app
ENV NODE_ENV=production \
	KEYZORI_SERVER_HOST=0.0.0.0 \
	KEYZORI_SERVER_PORT=3000 \
	PATH=/app

COPY --from=builder --chown=nonroot:nonroot /app/apps/server/dist/ /app/

USER nonroot:nonroot

EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=5 \
	CMD ["/app/keyzori", "healthcheck"]

ENTRYPOINT ["/app/keyzori"]
CMD ["serve"]
STOPSIGNAL SIGTERM
