# shelleport

Browser control plane for host-local coding CLI agents.

Current v1:
- generic core
- Claude live adapter via real `claude` CLI
- Codex historical-session import only
- Bun-first daemon
- API-first; UI deferred
- single admin token auth

## What it does

- starts managed Claude Code sessions in arbitrary directories on the host
- streams structured session events over SSE
- persists managed sessions in local SQLite
- imports historical Claude and Codex sessions from local disk
- exposes `serve`, `doctor`, and `install-service` commands

## What it does not do yet

- no arbitrary live adoption of already-running external TUIs
- no Codex live control yet
- no multi-user auth or RBAC
- no Windows-host support

## Commands

```bash
bun run start
bun run doctor
bun run install-service
bun run test
bun run test:claude
```

## Local auth

Set:

```bash
export SHELLEPORT_ADMIN_TOKEN='change-me'
```

If `SHELLEPORT_ADMIN_TOKEN` is unset, dev mode falls back to `dev-token`.

API auth:
- `Authorization: Bearer $SHELLEPORT_ADMIN_TOKEN`

## Runtime data

Default data dir:

```bash
$XDG_DATA_HOME/shelleport
# or
~/.local/share/shelleport
```

SQLite lives there as `shelleport.sqlite`.

## Provider notes

### Claude

- execution path: real `claude` CLI
- managed runs use `claude -p --verbose --output-format stream-json`
- approvals are modeled as deny/resume:
  - Claude returns `permission_denials`
  - shelleport creates pending approval requests
  - approved requests add `--allowedTools`
  - shelleport resumes the same Claude session with `-r`
- historical resume/import scans `~/.claude/projects`

### Codex

- local history import scans `~/.codex/sessions`
- live adapter intentionally deferred; provider contract already exists

## HTTP API

`POST /api/sessions`

```json
{
  "provider": "claude",
  "cwd": "/abs/path",
  "prompt": "Run git commit --allow-empty -m test and then say done"
}
```

`GET /api/sessions/:id/events`

- SSE stream
- first message: `snapshot`
- later messages: `session`, `event`, `request`

`request` objects include:
- `blockReason: "permission" | "sandbox" | null`

Current Claude behavior:
- `permission` => can be approved and resumed
- `sandbox` => informative only; not overridable via `--allowedTools`

`POST /api/requests/:id/respond`

```json
{
  "decision": "allow"
}
```

Optional explicit rule:

```json
{
  "decision": "allow",
  "toolRule": "Bash(git commit:*)"
}
```

Other endpoints:
- `GET /api/providers`
- `GET /api/providers/:provider/sessions`
- `GET /api/sessions`
- `GET /api/sessions/:id`
- `POST /api/sessions/:id/input`
- `POST /api/sessions/:id/control`
- `POST /api/sessions/import`

## Service install

`bun run install-service`

Writes:
- macOS: `~/Library/LaunchAgents/dev.shelleport.plist`
- Linux: `~/.config/systemd/user/shelleport.service`

It does not auto-load the service; the command prints the next system command to run.

## Verification

```bash
bun run typecheck
bun run lint
bun run test
bun run test:claude
bun run doctor
```
