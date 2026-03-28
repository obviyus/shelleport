# Changelog

All notable changes to shelleport are documented here.

## Unreleased

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
