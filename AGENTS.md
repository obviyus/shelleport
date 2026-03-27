# Project Information

- **Goal**: Browser-based control plane for host-local coding CLI agents. Start, monitor, and interact with AI coding sessions on any machine via a web UI or HTTP API.
- **Approach**: Bun-native SSR + Bun-native browser bundling. One Bun server path, one app-owned router, one binary per platform.
- **UI Stack**: React 19 + React Compiler (useMemo/useCallback redundant), Tailwind CSS v4, shadcn/ui via `bunx shadcn@latest add ...`, lucide-react icons, motion v12 for animations.
- **Database**: `bun:sqlite` with WAL mode. Schema migrations are inline `ensureColumn()` calls, no migration framework. Data lives at `$XDG_DATA_HOME/shelleport/shelleport.sqlite`.
- **Runtime**: Bun-native everything — `Bun.serve`, `Bun.file()`, `Bun.spawn`, `bun:sqlite`. No Node.js `fs` on the server side.
- **Auth**: Single admin token (`SHELLEPORT_ADMIN_TOKEN`). Bearer header for API, localStorage on the client. Timing-safe comparison via `timingSafeEqual`.
- **Packaging**: Browser assets built into `build/client`. Release binaries compiled with `bun build --compile` and embed `/assets/client.js` + `/assets/client.css`.

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

- SSR is a **shell only**. Server injects boot data `{ defaultCwd, route }`. Real session data still comes from fetch + SSE after hydration.
- App routing is **owned locally**, not by a framework. Route matching lives in `app/web/routes.ts`; browser history plumbing lives in `app/web/router.tsx`.
- Main authenticated shell lives in `app/web/app-shell.tsx`. Login lives in `app/web/login-page.tsx`. SSR document/render path lives in `app/server/web.server.tsx`.
- State management is plain `useState` — no Redux, Zustand, or React Query.
- SSE messages: `snapshot` (full hydration), `session` (metadata update), `event` (append), `request` (approval flow).
- Tool calls are paired with their results via `toolUseId` for collapsible card rendering.

### Routes

| Path                   | Owner                 | Purpose                                |
| :--------------------- | :-------------------- | :------------------------------------- |
| `/`                    | `app/web/routes.ts`   | Main session shell                     |
| `/sessions/:sessionId` | `app/web/routes.ts`   | Session detail shell                   |
| `/archived`            | `app/web/routes.ts`   | Archived session list                  |
| `/login`               | `app/web/routes.ts`   | Token login                            |
| `/logout`              | `app/server/web.server.tsx` | Clear local token and redirect   |
| `/api/*`               | `app/server/api.server.ts`  | API only                          |

When adding a new browser route, update `matchAppRoute()` in `app/web/routes.ts` and app rendering in `app/web/app.tsx`.

### Server layout

| File                               | Responsibility                                        |
| :--------------------------------- | :---------------------------------------------------- |
| `server.ts`                        | CLI entry point + Bun route dispatch                  |
| `app/server/web.server.tsx`        | SSR document rendering + asset responses              |
| `app/server/api.server.ts`         | HTTP request dispatcher for all `/api/*` routes       |
| `app/server/session-broker.server.ts` | Session lifecycle, in-process pub/sub, approval flow |
| `app/server/store.server.ts`       | SQLite persistence (sessions, events, requests)       |
| `app/server/auth.server.ts`        | Bearer token auth only                                |
| `app/server/config.server.ts`      | Env var config                                        |
| `app/server/providers/claude.server.ts` | Claude Code adapter (live + historical)          |
| `app/server/providers/codex.server.ts`  | Codex adapter (historical import only)           |

### Build layout

| File                     | Responsibility                                  |
| :----------------------- | :---------------------------------------------- |
| `scripts/build.ts`       | Tailwind compile + Bun browser bundle           |
| `scripts/package.ts`     | Compile local/release binaries                  |
| `scripts/npm-runtime.js` | Download correct release binary on npm install  |
| `scripts/smoke.ts`       | Verify compiled binary works without `build/`   |

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

- **UI**: Current product ships dark-only. Preserve current look unless asked to redesign.
- **Icons**: Use lucide-react. Verify icon names exist before using (e.g., `FlaskConical` not `Flask`).
- **Dependencies**: Prefer Bun built-ins over third-party packages. Use `bun:sqlite`, `Bun.file()`, `Bun.serve`, `Bun.spawn`.
- **SQL columns**: Use `_time` suffix for timestamps (`create_time`, `update_time`).
- **No SVG hardcoding**: Import from lucide-react.
- **motion v12**: Use for animations and transitions.
- **Routing**: No React Router. No route-module files. No framework loaders/actions.
- **Auth**: No cookie sessions. No dual auth path. Bearer only.
