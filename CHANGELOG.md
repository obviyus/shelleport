# Changelog

All notable changes to shelleport are documented here.

## Unreleased

### Added

- Desktop sidebars now show a keyboard shortcut legend above the Claude limits panel (#28) (thanks @kesava500)
- Sidebar session rows now show cumulative session cost beside the relative update time when provider usage data is available (#33) (thanks @kesava500)
- Browsers now warn before closing a tab while a session is still running or retrying (#34) (thanks @kesava500)
- Archived sessions can now be deleted permanently from the browser, including their stored event/request/input data and upload files (#31) (thanks @kesava500)
- Browser actions now show visible toast errors instead of failing silently when session creation, metadata changes, or approval/queue actions fail (#32) (thanks @kesava500)
- HTTP responses now include baseline security headers, and failed login attempts are rate-limited per client IP (#29) (thanks @kesava500)
- Claude sessions can now choose a specific model at launch and switch models for later prompts from the session header (#39) (thanks @kesava500)
- Sessions can now be organized into projects from the launcher and sidebar, with create, save-as-project, move, and delete flows in the browser (#38) (thanks @kesava500)

### Fixed

- Sidebar session rows now keep pin and archive actions visible on mobile instead of hiding them behind hover-only styles (#30) (thanks @kesava500)

## 0.0.24 - 2026-03-29

### Fixed

- Linux ARM64 native binaries no longer hang during `shelleport upgrade` after printing the download banner; upgrades now finish instead of spinning in Bun's streamed file writer path

## 0.0.23 - 2026-03-29

### Added

- Idle, interrupted, and completed sessions now show relative update times in the sidebar instead of repeating the cwd path (#13) (thanks @kesava500)
- Session views now page older events instead of loading the full event history at once, with a load-earlier control for older messages (#14) (thanks @kesava500)
- Session code blocks and tool results now include copy buttons in the chat transcript (#15) (thanks @kesava500)
- Write and Edit tool cards now show the actual file content being written instead of only the result summary (#16) (thanks @kesava500)
- Browser tabs now show the selected session title and status while you are viewing a session (#17) (thanks @kesava500)
- Browser notifications now fire when a background session finishes or fails while you are viewing that session (#18) (thanks @kesava500)
- Sessions now auto-title from the first prompt instead of keeping the generic provider title (#19) (thanks @kesava500)
- Session views can now copy the full conversation transcript as markdown (#20) (thanks @kesava500)
- Running sessions can now be interrupted with Ctrl+C from the browser, with clean interrupted-session messaging instead of a CLI error card (#21) (thanks @kesava500)
- Session views now show a visible reconnect banner when the live stream drops instead of only a tiny badge in the header (#22) (thanks @kesava500)
- The browser tab now uses an inline shell favicon instead of the default blank icon (#23) (thanks @kesava500)
- The prompt composer now supports shell-style history recall with Up/Down arrow keys across page refreshes (#24) (thanks @kesava500)
- Claude thinking/reasoning blocks now render as collapsible transcript sections and stay labeled as thinking in transcript exports (#25) (thanks @kesava500)
- New installs now show a first-run readiness card in the browser so setup problems are explicit before you launch a session

### Fixed

- Rate limit updates no longer render as inline chat events now that those provider limit updates already live in the sidebar limits panel
- Session list search now shows a specific no-results state instead of the generic empty-workspace message
- Browser chat selection no longer risks clearing every second because time-based sidebar/header labels own their own local clock updates
- Claude streamed thinking/tool deltas now only suppress duplicate assistant events for the current response instead of leaking into later assistant messages
- Bun tests now preload an isolated `SHELLEPORT_DATA_DIR` so import-time store initialization cannot write fixture data into a real install
- Session views now recover cleanly when their UI state or live stream gets out of sync instead of dropping you into a broken blank state

## 0.0.22 - 2026-03-28

### Fixed

- `shelleport upgrade` now streams release downloads to disk with a live progress bar instead of looking frozen for large binaries
- `shelleport upgrade` now reports checksum download progress separately so slow GitHub asset fetches are visible

## 0.0.21 - 2026-03-28

### Fixed

- Tool call cards now keep their matching tool results together even when other session events arrive between them
- Sessions now accept general file attachments instead of only images, with image previews preserved where available (#5) (thanks @kesava500)

## 0.0.20 - 2026-03-28

### Fixed

- `shelleport upgrade` now prints progress instead of appearing hung during release checks, downloads, installs, and service restarts
- `shelleport upgrade` now exits early when the installed version already matches the latest release
- `shelleport upgrade` now fails immediately with a clear sudo requirement when a system install needs root-owned paths

## 0.0.19 - 2026-03-28

### Fixed

- Session launcher now keeps the actual selected directory highlighted instead of promoting the first child entry (#1) (thanks @kesava500)
- Session headers now show the active model badge without duplicating the old reset countdown there (#2) (thanks @kesava500)
- Session launcher now scrolls correctly on mobile instead of clipping the directory browser near the bottom (#3) (thanks @kesava500)

## 0.0.18 - 2026-03-28

### Changed

- Linux `install-service` now installs a canonical native binary at `/usr/local/lib/shelleport/shelleport` and creates `/usr/local/bin/shelleport`
- Linux systemd units now run the canonical native binary with explicit `--host` and `--port` arguments instead of relying on wrapper-specific behavior

### Fixed

- Added a native `shelleport upgrade` command to packaged binaries
- Linux upgrades now repair the installed `shelleport.service`, reload systemd, upgrade the binary, and restart the service in one step

## 0.0.17 - 2026-03-28

### Fixed

- Session switches no longer flash the new-session launcher before the target chat hydrates
- Session event streams now hold one SSE connection per selected chat instead of repeatedly reconnecting during session hydration

## 0.0.16 - 2026-03-27

### Changed

- Claude bypass mode now uses the current `bypassPermissions` flag, and existing stored sessions are migrated off the old `dontAsk` value
- Linux `install-service` now writes a plain systemd unit at `/etc/systemd/system/shelleport.service` and runs it as an explicit service user
- `shelleport upgrade` now targets the system `shelleport.service` on Linux

### Fixed

- Service installs and upgrades now preserve the Claude CLI path in the service environment so restarts do not lose access to `claude`

## 0.0.15 - 2026-03-27

### Changed

- Claude sessions now default to bypass permissions mode, with a first-run warning and per-session override in the launcher
- Active Claude sessions now show their permission mode in the session header

### Fixed

- Stale `running`, `retrying`, and orphaned `waiting` sessions now recover to `interrupted` after a shelleport restart instead of staying wedged

## 0.0.14 - 2026-03-27

### Changed

- `install-service` now starts the service immediately instead of printing follow-up daemon commands
- Service installs now default to `0.0.0.0`, while `--tailscale` still binds the machine's Tailscale IPv4
- Default port is now `1206`

### Fixed

- Added a real `--version` CLI flag and parser coverage for packaged CLI argument handling

## 0.0.13 - 2026-03-27

### Fixed

- Smoke now injects a known executable for Claude readiness checks so release CI does not depend on `claude` being installed on the runner

## 0.0.12 - 2026-03-27

### Fixed

- Release-gate formatting regressions so `bun run check`, `bun test`, and `bun run smoke` pass before tagging

## 0.0.11 - 2026-03-27

### Added

- `--host`, `--port`, `--public`, and `--tailscale` CLI flags for explicit server binding

### Changed

- `install-service` now writes the selected bind address into launchd and systemd service definitions
- Server startup now prints reachable local and Tailscale URLs when available

### Fixed

- `--help` now exits cleanly without booting the server or touching SQLite

## 0.0.10 - 2026-03-27

### Fixed

- Release check formatting regression in `api.server` image upload tests

## 0.0.9 - 2026-03-27

### Added

- Claude quota tracking with live usage and limit display
- Session search powered by SQLite FTS
- Pinned and renamed chats

### Changed

- Updated README with preview image and cleaner feature list

### Fixed

- Browser assets now reload from disk in dev mode
- Unified dev and production asset serving

## 0.0.8 - 2026-03-27

### Fixed

- Admin token seeding in `web.server` tests for consistent CI authentication

## 0.0.7 - 2026-03-27

### Added

- Runtime install progress indicator and clickable startup URL
- Admin token auth with hash-only storage and session cookies
- `shelleport token` command for token management

### Changed

- Removed `SHELLEPORT_ADMIN_TOKEN` env var in favor of single auth model

### Fixed

- Release binaries now serve the same assets as dev, including Tailwind CSS

## 0.0.6 - 2026-03-27

### Fixed

- Test isolation for `sessionBroker` methods in CI

## 0.0.5 - 2026-03-27

### Added

- Auto-install native runtime on first CLI run when the install hook was skipped

## 0.0.4 - 2026-03-27

### Fixed

- GitHub Actions now uses `bun run check` and `bun run test` for tag builds

## 0.0.3 - 2026-03-27

### Fixed

- Serialized test runner (`--max-concurrency 1`) for deterministic CI

## 0.0.2 - 2026-03-27

First real public release.

### Added

- Bun-native fullstack runtime with SSR and embedded boot data
- Native single-file binary packaging per platform
- npm wrapper package with automatic platform binary install
- Browser session control plane with SSE streaming
- Inline permission approvals (Allow / Deny)
- Finder-style directory browser and session launcher
- Image attachments via paste or upload
- Session archive, restore, interrupt, and terminate
- Historical session import from `~/.claude/projects`
- Rate limit detection with live retry countdown
- Cookie-based browser auth
- GitHub Actions CI and tag-based release publishing

## 0.0.1 - 2026-03-27

Bootstrap npm publish to reserve the `shelleport` package name.
