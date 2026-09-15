#!/usr/bin/env bash
# Runs the Next.js server exactly as the desktop EXE's local runtime sees it:
# SPACEWORKER_LOCAL_EXE=true (the ONLY `.env` that ever sets it — fail-closed on the
# deployed VPS), BUILD_TARGET=extractor, and the local license secret loaded from
# the repo .env via Next's dotenv. DevUrl points here (see tauri.conf.json).
#
# Long-running by design — `tauri dev` runs this as beforeDevCommand and waits.
set -euo pipefail
cd "$(dirname "$0")/.."

export SPACEWORKER_LOCAL_EXE=true
export BUILD_TARGET="${BUILD_TARGET:-extractor}"

# Read EXE_LICENSE_SECRET from .env if it isn't already set (dev convenience; the
# packaged EXE embeds it at build time). Never override an explicitly-set value.
if [[ -z "${EXE_LICENSE_SECRET:-}" && -f .env ]]; then
  # shellcheck disable=SC2046
  export "$(grep -E '^EXE_LICENSE_SECRET=' .env | head -1)"
fi

exec npm run dev