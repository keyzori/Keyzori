FROM --platform=$BUILDPLATFORM oven/bun:1.4.2-slim AS build
WORKDIR /app
COPY package.json bun.lock tsconfig.json ./
COPY src/package.json ./src/package.json
RUN HUSKY=0 bun install --frozen-lockfile
COPY src ./src
ARG TARGETARCH
RUN case "$TARGETARCH" in amd64) bun src/scripts/build.ts linux-x64 ;; arm64) bun src/scripts/build.ts linux-arm64 ;; *) exit 1 ;; esac && \
	cp dist/server/keyzori-linux-* /app/keyzori

FROM gcr.io/distroless/cc-debian12:nonroot AS runtime
WORKDIR /app
COPY --from=build --chown=65532:65532 --chmod=755 /app/keyzori /app/keyzori
USER 65532:65532
ENV KZ_API_HOST=0.0.0.0 KZ_API_PORT=6284
EXPOSE 6284
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 CMD ["/app/keyzori", "healthcheck"]
ENTRYPOINT ["/app/keyzori"]
CMD ["serve"]
