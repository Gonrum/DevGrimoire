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
        gnupg \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI (gh) — official apt repo. Token via $GH_TOKEN at runtime, no
# `gh auth login` needed. Keyring lives in /etc/apt/keyrings per Debian policy.
RUN install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        | tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# GitLab CLI (glab) — static binary from the official generic-packages registry.
# Reads $GITLAB_TOKEN and $GITLAB_HOST at runtime; no config file needed for
# basic read/write. Pin via GLAB_VERSION so the image is reproducible.
ARG GLAB_VERSION=1.93.0
RUN ARCH=$(dpkg --print-architecture) \
    && case "$ARCH" in \
         amd64|arm64) GLAB_ARCH="$ARCH" ;; \
         *) echo "unsupported arch: $ARCH" && exit 1 ;; \
       esac \
    && curl -fsSL "https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/packages/generic/glab/${GLAB_VERSION}/glab_${GLAB_VERSION}_linux_${GLAB_ARCH}.tar.gz" \
        -o /tmp/glab.tar.gz \
    && tar -xz -C /tmp -f /tmp/glab.tar.gz \
    && mv /tmp/bin/glab /usr/local/bin/glab \
    && chmod +x /usr/local/bin/glab \
    && rm -rf /tmp/glab.tar.gz /tmp/bin /tmp/LICENSE /tmp/README.md \
    && gh --version && glab --version

# Non-root user for all workspace operations. UID 10001 keeps the volume
# files clearly outside common host UIDs.
RUN useradd --create-home --uid 10001 --shell /bin/bash workspace \
    && mkdir -p /workspaces \
    && chown workspace:workspace /workspaces

WORKDIR /app
COPY --chown=workspace:workspace server/package.json server/package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

COPY --chown=workspace:workspace server/ ./

# DevGrimoire workspace CLI (T-168). Bash script + python3 (already in image)
# for JSON encoding. Reads DG_API_URL/DG_API_TOKEN/DG_WORKSPACE_ID from env
# that the backend auto-injects at every workspace_exec call.
COPY dg-cli/dg /usr/local/bin/dg
RUN chmod +x /usr/local/bin/dg && /usr/local/bin/dg --version

USER workspace
ENV NODE_ENV=production \
    PORT=9000 \
    WORKSPACE_ROOT=/workspaces

EXPOSE 9000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
    CMD curl -fsS http://localhost:9000/health || exit 1

CMD ["node", "index.js"]
