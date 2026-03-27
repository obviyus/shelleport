# 🐚 shelleport

**A web UI for your coding agents, anywhere.**

Start, monitor, and interact with AI coding sessions on any machine. All from your browser.

## Getting Started

### Prerequisites

- A coding agent CLI installed and authenticated (e.g. [Claude Code](https://docs.anthropic.com/en/docs/claude-code))

### Install & Run

Install with npm:

```bash
npm i -g shelleport
shelleport serve
```

Or download the latest binary from [Releases](https://github.com/obviyus/shelleport/releases) and run:

```bash
shelleport serve
```

### Install as a Service

Shelleport can install itself as a background service that starts automatically:

```bash
shelleport install-service
```

This writes a service definition for your platform (launchd on macOS, systemd on Linux) and prints the command to activate it.

### Health Check

```bash
shelleport doctor
```

Verifies your data directory, CLI availability, host/port config, and token status.

## Features

- [x] Real-time SSE streaming with automatic reconnection
- [x] Syntax-highlighted tool call visualization with collapsible cards
- [x] Inline permission approvals (Allow/Deny) for tool boundaries
- [x] Finder-style directory browser to launch sessions in any directory
- [x] Image attachments via paste or upload
- [x] Session archive, restore, interrupt, and terminate
- [x] Historical session import from `~/.claude/projects`
- [x] Rate limit detection with live retry countdown
- [x] Native single-file per-platform binaries built with `bun build --compile`
- [x] Background service install (launchd / systemd)
- [ ] Codex App Server support
- [ ] Skills support
- [ ] Automations support
- [ ] Settings page

## Supported Agents

| Agent           | Live Sessions | Historical Import |
| :-------------- | :-----------: | :---------------: |
| **Claude Code** |      Yes      |        Yes        |
| **Codex**       |    Planned    |      Planned      |

The provider system is extensible — add new agents by implementing the `ProviderAdapter` interface.

## Configuration

### Environment Variables

| Variable                 | Default     | Description                                |
| :----------------------- | :---------- | :----------------------------------------- |
| `SHELLEPORT_ADMIN_TOKEN` | `dev-token` | Bearer token for API and UI authentication |
| `HOST`                   | `127.0.0.1` | Bind address                               |
| `PORT`                   | `3000`      | Bind port                                  |

### Data Storage

All data lives in `$XDG_DATA_HOME/shelleport` (defaults to `~/.local/share/shelleport`). The SQLite database stores sessions and events. Image attachments are saved in each session's working directory under `.shelleport/uploads/`.

## API Reference

Shelleport is API-first. Every action in the UI goes through the HTTP API.

### Sessions

```
POST   /api/sessions                  # Create a new session
GET    /api/sessions                  # List all sessions
GET    /api/sessions/:id              # Get session details
GET    /api/sessions/:id/events       # SSE event stream
POST   /api/sessions/:id/input        # Send a follow-up prompt
POST   /api/sessions/:id/control      # Interrupt or terminate
POST   /api/sessions/import           # Import historical sessions
```

### Approvals

```
POST   /api/requests/:id/respond      # Allow or deny a permission request
```

### Other

```
POST   /api/auth/session              # Exchange admin token for auth cookie
GET    /api/auth/session              # Validate current auth cookie
DELETE /api/auth/session              # Clear auth cookie
GET    /api/providers                 # List available providers
GET    /api/providers/:name/sessions  # List sessions for a provider
GET    /api/directories               # Browse host directories
```

API endpoints require the auth cookie after login. Bearer auth still works for direct API callers.

## Development

```bash
bun run dev          # Bun source server with hot reload
bun run build        # Ahead-of-time client bundle
NODE_ENV=production bun run server.ts serve  # Run from source
bun run compile      # Build the local standalone binary
bun run typecheck    # Type-check with tsgo
bun run lint         # Lint with oxlint
bun run format       # Check formatting with oxfmt
bun run test         # Run tests
bun run smoke        # Verify the compiled binary works without build/
bun run test:claude  # Run Claude integration tests
```
