# Project Information

- **Goal**: Browser-based control plane for host-local coding CLI agents. Start, monitor, and interact with AI coding sessions on any machine via a web UI or HTTP API.
- **Approach**: React Router 7 (framework mode) with Bun.serve. The main UI is a client-side SPA shell — loaders are minimal, all real data flows through SSE + fetch.
- **UI Stack**: React 19 + React Compiler (useMemo/useCallback redundant), Tailwind CSS v4, shadcn/ui via `bunx shadcn@latest add ...`, lucide-react icons, motion v12 for animations.
- **Database**: `bun:sqlite` with WAL mode. Schema migrations are inline `ensureColumn()` calls, no migration framework. Data lives at `$XDG_DATA_HOME/shelleport/shelleport.sqlite`.
- **Runtime**: Bun-native everything — `Bun.serve`, `Bun.file()`, `Bun.spawn`, `bun:sqlite`. No Node.js `fs` on the server side.
- **Auth**: Single admin token (`SHELLEPORT_ADMIN_TOKEN`). Bearer header for API, localStorage on the client. Timing-safe comparison via `timingSafeEqual`.

## Architecture

### Data flow

```
Browser ──fetch──► /api/* ──► api.server.ts ──► sessionBroker ──► provider (claude/codex)
   ▲                                                │
   └──────────── SSE stream ◄── publish() ◄─────────┘
```

- **SSE over fetch**, not EventSource — to support Authorization headers. Manual `ReadableStream` parsing with `\n\n` delimiters.
- **In-process pub/sub** via module-level `Map<sessionId, Set<subscriber>>`. Single-process only, no external message queue.
- **Providers are async generators** — they yield `ProviderAdapterEvent` and the broker consumes with `for await`, writing to SQLite and fanning out to SSE subscribers.

### Key patterns

- The main UI (`home.tsx`) is a **client-side SPA shell**. The route loader returns only `{ defaultCwd }`. All session data, events, and pending requests are loaded via `useEffect` + SSE.
- State management is plain `useState` — no Redux, Zustand, or React Query.
- SSE messages: `snapshot` (full hydration), `session` (metadata update), `event` (append), `request` (approval flow).
- Tool calls are paired with their results via `toolUseId` for collapsible card rendering.

### Routes

| Path | File | Purpose |
|:-----|:-----|:--------|
| `/` | `home.tsx` | Main SPA shell (sidebar + chat) |
| `/sessions/:sessionId` | `session.tsx` | Session view (re-exports home) |
| `/archived` | `archived.tsx` | Archived sessions (re-exports home) |
| `/api/*` | `api.ts` | Passthrough to `api.server.ts` |
| `/login` | `login.tsx` | Token login |
| `/logout` | `logout.ts` | Clear session |

When adding a new route, add a corresponding entry in `app/routes.ts`.

### Server layout

| File | Responsibility |
|:-----|:---------------|
| `server.ts` | CLI entry point: `serve`, `doctor`, `install-service` |
| `api.server.ts` | HTTP request dispatcher for all `/api/*` routes |
| `session-broker.server.ts` | Session lifecycle, in-process pub/sub, approval flow |
| `store.server.ts` | SQLite persistence (sessions, events, requests) |
| `auth.server.ts` | Bearer token + cookie session auth |
| `config.server.ts` | Env var config |
| `providers/claude.server.ts` | Claude Code adapter (live + historical) |
| `providers/codex.server.ts` | Codex adapter (historical import only) |

### Provider interface

```ts
interface ProviderAdapter {
  readonly id: ProviderId;
  capabilities(): ProviderCapabilities;
  sendInput(input): AsyncGenerator<ProviderAdapterEvent>;
  resumeSession(session, input): AsyncGenerator<ProviderAdapterEvent>;
  listHistoricalSessions(): Promise<HistoricalSession[]>;
}
```

Providers yield events; the broker consumes them. To add a new provider, implement this interface and register it in `registry.server.ts`.

## Conventions

- **UI**: Light mode only. Clean, minimal, shadcn-inspired.
- **Icons**: Use lucide-react. Verify icon names exist before using (e.g., `FlaskConical` not `Flask`).
- **Dependencies**: Prefer Bun built-ins over third-party packages. Use `bun:sqlite`, `Bun.file()`, `Bun.serve`, `Bun.spawn`.
- **SQL columns**: Use `_time` suffix for timestamps (`create_time`, `update_time`).
- **No SVG hardcoding**: Import from lucide-react.
- **motion v12**: Use for animations and transitions.
