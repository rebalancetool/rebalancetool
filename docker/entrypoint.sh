#!/bin/sh
# Bring the dependency volumes in line with pnpm-lock.yaml, then run the
# requested command. --frozen-lockfile never rewrites the lockfile (the repo
# is mounted read-only anyway); when the volumes are already current this is
# a ~1s no-op. Set SKIP_INSTALL=1 to bypass it (e.g. offline).
set -e
if [ "${SKIP_INSTALL:-0}" != "1" ]; then
  pnpm install --frozen-lockfile --prefer-offline \
    --store-dir /pnpm-store --config.confirmModulesPurge=false >&2
fi
exec "$@"
