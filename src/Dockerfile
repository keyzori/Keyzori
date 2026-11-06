FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4 AS dependencies
WORKDIR /app
# Install the reviewed runtime; a moving canary tag is not interchangeable.
COPY .bun-version .bun-revision ./
RUN BUN_INSTALL=/opt/keyzori-bun \
    BUN_INSTALL_GLOBAL_DIR=/opt/keyzori-bun/install/global \
    BUN_INSTALL_BIN=/opt/keyzori-bun/bin \
    bun add --global --trust "bun@$(cat .bun-version)" && \
    cp -L /opt/keyzori-bun/bin/bun /usr/local/bin/keyzori-bun && \
    test "$(/usr/local/bin/keyzori-bun --revision)" = "$(cat .bun-revision)"
COPY package.json bun.lock ./
COPY src/package.json ./src/package.json
RUN HUSKY=0 keyzori-bun install --production --frozen-lockfile --ignore-scripts

FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4 AS runtime
WORKDIR /app
COPY --from=dependencies /usr/local/bin/keyzori-bun /usr/local/bin/keyzori-bun
COPY --from=dependencies --chown=65532:65532 /app/node_modules ./node_modules
COPY --chown=65532:65532 package.json LICENSE .bun-version .bun-revision ./
COPY --chown=65532:65532 src ./src
USER 65532:65532
ENV KZ_API_HOST=0.0.0.0 KZ_API_PORT=6284
EXPOSE 6284
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 CMD ["keyzori-bun", "--no-env-file", "src/main.ts", "healthcheck"]
ENTRYPOINT ["keyzori-bun", "--no-env-file", "src/main.ts"]
CMD ["serve"]