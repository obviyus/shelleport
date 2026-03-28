#!/bin/bash
set -euo pipefail
bunx oxfmt --check autoresearch.md autoresearch.sh autoresearch.checks.sh scripts/bench-claude-turns.ts src/server/config.server.ts src/server/providers/claude.server.ts src/server/api.server.test.ts >/tmp/shelleport-format.log 2>&1 || { tail -80 /tmp/shelleport-format.log; exit 1; }
bun test ./src/server/api.server.test.ts ./src/server/server.test.ts --max-concurrency 1 >/tmp/shelleport-test.log 2>&1 || { tail -80 /tmp/shelleport-test.log; exit 1; }
