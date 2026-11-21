# Dev/test image: Node + pnpm inside a container, so neither runs on the host.
# The repo itself is NOT copied in — compose bind-mounts it read-only at
# /app, and dependencies are installed at container start into named
# volumes (see compose.yaml and docker/entrypoint.sh).
FROM node:24-bookworm-slim

# Bake the pnpm version pinned in package.json's packageManager field into
# the image via Corepack (signature-verified), so nothing downloads pnpm at
# run time. COREPACK_HOME lives outside $HOME so it survives the read-only
# root filesystem + tmpfs home in compose.yaml.
ENV COREPACK_HOME=/opt/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    PNPM_HOME=/home/node/.local/share/pnpm
RUN corepack enable && corepack prepare pnpm@11.11.0 --activate \
 && chmod -R a+rX /opt/corepack

# Pre-create every node_modules mount point owned by the unprivileged
# `node` user, so the named volumes compose mounts over them inherit that
# ownership instead of root's.
RUN mkdir -p /app/node_modules \
             /app/apps/web/node_modules /app/apps/cli/node_modules \
             /app/packages/solver/node_modules \
             /app/apps/web/dist /app/apps/cli/dist /app/packages/solver/dist \
             /pnpm-store \
 && chown -R node:node /app /pnpm-store

COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/rebalancer-entrypoint

USER node
WORKDIR /app
ENTRYPOINT ["rebalancer-entrypoint"]
CMD ["pnpm", "run", "test"]
