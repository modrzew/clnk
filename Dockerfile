# syntax=docker/dockerfile:1

# One image for both halves: the backend serves the built web UI at / (see server/config.ts).
ARG BUN_VERSION=1.4.4

FROM oven/bun:${BUN_VERSION} AS web
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY index.html vite.config.ts tsconfig.json tsconfig.node.json ./
COPY scripts scripts
COPY public public
COPY shared shared
COPY src src
RUN bun run build

FROM oven/bun:${BUN_VERSION}
LABEL org.opencontainers.image.source="https://github.com/modrzew/clnk"

# Tools Pi reaches for from its bash tool.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git jq python3 ripgrep \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json bun.lock ./
# Pi itself comes in as the @earendil-works/pi-coding-agent dependency.
RUN bun install --frozen-lockfile --production
COPY server server
COPY shared shared
COPY --from=web /app/dist dist

ENV HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/data \
    PI_CODING_AGENT_DIR=/home/bun/.pi/agent
# Created here so named volumes mounted on them start out owned by bun.
RUN mkdir -p /data /home/bun/.pi/agent && chown -R bun:bun /data /home/bun/.pi
USER bun

EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD curl -fsS http://127.0.0.1:8787/api/health || exit 1
CMD ["bun", "server/index.ts"]
