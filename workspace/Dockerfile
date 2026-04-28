FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        git \
        ripgrep \
        jq \
        curl \
        ca-certificates \
        python3 \
        python3-pip \
        build-essential \
    && rm -rf /var/lib/apt/lists/*

# Non-root user for all workspace operations. UID 10001 keeps the volume
# files clearly outside common host UIDs.
RUN useradd --create-home --uid 10001 --shell /bin/bash workspace \
    && mkdir -p /workspaces \
    && chown workspace:workspace /workspaces

WORKDIR /app
COPY --chown=workspace:workspace server/package.json server/package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

COPY --chown=workspace:workspace server/ ./

USER workspace
ENV NODE_ENV=production \
    PORT=9000 \
    WORKSPACE_ROOT=/workspaces

EXPOSE 9000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
    CMD curl -fsS http://localhost:9000/health || exit 1

CMD ["node", "index.js"]
