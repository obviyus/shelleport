# Changelog

All notable changes to shelleport are documented here.

## Unreleased

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
