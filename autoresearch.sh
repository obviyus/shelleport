#!/bin/bash
set -euo pipefail
SHELLEPORT_CLAUDE_BARE=1 bun run ./scripts/bench-claude-turns.ts
