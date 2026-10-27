#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
exec "${SYDNEY_PY:-python3}" portrait_server.py
