# Autoresearch: Claude turn latency and process reuse

## Objective

Reduce the end-to-end latency of sending messages from ShelLeport into Claude Code and relaying the response back. Current focus: evaluate an opt-in reduced-runtime Claude launch mode that is materially faster, while keeping it explicitly non-default so normal managed-session semantics remain unchanged unless the operator chooses the tradeoff.

## Metrics

- **Primary**: `conversation_total_ms` (ms, lower is better) — median total time for three consecutive turns on the same ShelLeport session through the real HTTP + SSE path
- **Secondary**: `first_turn_ms`, `second_turn_ms`, `third_turn_ms`, `first_event_ms`, `create_session_ms`, `direct_spawn_ms`, `direct_bare_ms`

## How to Run

`./autoresearch.sh` — starts ShelLeport in production mode, uses the real local `claude` binary when available, creates a managed Claude session, sends three prompts over HTTP, waits for SSE-delivered completion after each turn, and prints structured `METRIC ...` lines.

## Real Workload Notes

- This machine has a real Claude Code binary installed.
- The local Claude CLI is currently **not logged in**, so the real workload returns the real `Not logged in · Please run /login` response.
- That still exercises the startup path, plugin loading, process boot, stream handling, request dispatch, and turn completion logic we care about for this optimization.
- We will not overfit to the unauthenticated case; any kept optimization must be architectural and plausibly help authenticated turns too.

## Files in Scope

- `src/server/providers/claude.server.ts` — Claude CLI process management and stream parsing
- `src/server/session-broker.server.ts` — run lifecycle and per-session orchestration
- `src/server/api.server.ts` — session input path
- `src/server/store.server.ts` — session/event persistence touched by turn handling
- `src/server/providers/provider.server.ts` — provider contract if needed
- `scripts/bench-claude-turns.ts` — benchmark harness
- `autoresearch.sh` / `autoresearch.checks.sh` / `autoresearch.ideas.md`

## Off Limits

- No benchmark-only fast paths
- No dropping events, session updates, or approval behavior just to look faster
- No semantic regression in managed session behavior
- No switching to a materially reduced Claude mode unless we can justify keeping user-visible behavior intact

## Constraints

- Keep the benchmark HTTP-based and route through ShelLeport, not a synthetic microbenchmark only
- Use real Claude CLI where available
- Passing targeted tests/checks required before keeping
- Preserve support for approvals, resume, interrupts, and SSE event delivery

## What's Been Tried

- Prior route-latency autoresearch was the wrong target and has been abandoned.
- Manual CLI experiments on this machine show the key opportunity clearly:
  - fresh `claude -p ...` runs take roughly multi-second wall time per turn here even when Claude immediately returns an auth error
  - a single long-lived `claude -p --input-format stream-json --output-format stream-json --replay-user-messages --verbose ...` process stays alive across turns and can answer warm follow-up turns in only a few milliseconds on this machine
- This suggests ShelLeport should strongly consider a per-session persistent Claude subprocess instead of spawn-per-turn.
- Tried persistent per-session reuse in ShelLeport and discarded it for now: the real current workload regressed despite direct CLI tests looking promising.
- Tried disabling slash commands and discarded it: no meaningful startup improvement.
- New promising path: `claude --bare` appears dramatically faster on this machine, but changes semantics enough that it should only be exposed as an explicit opt-in mode if kept.
