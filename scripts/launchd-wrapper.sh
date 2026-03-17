#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

export PATH="/opt/homebrew/bin:/Users/aias/.bun/bin:/Users/aias/.nvm/versions/node/v22.22.0/bin:${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"

cd "${REPO_ROOT}"

exec /bin/bash "${SCRIPT_DIR}/restart-supervisor.sh" -- /Users/aias/.nvm/versions/node/v22.22.0/bin/node "${SCRIPT_DIR}/start-with-proxy.mjs"
