# Project Information

- **Goal**: Browser-based control plane for host-local coding CLI agents. Start, monitor, and interact with AI coding sessions on any machine via a web UI or HTTP API.
- **Approach**: Bun-native fullstack HTML import + Bun-native server/API path. Bun owns browser asset bundling; app owns client-side route matching/state after bootstrap. One Bun server path, one binary per platform.
- **UI Stack**: React 19 + React Compiler (useMemo/useCallback redundant), Tailwind CSS v4, shadcn/ui via `bunx shadcn@latest add ...`, lucide-react icons, motion v12 for animations.
- **Database**: `bun:sqlite` with WAL mode. Schema migrations are inline `ensureColumn()` calls, no migration framework. Data lives at `$XDG_DATA_HOME/shelleport/shelleport.sqlite`.
- **Runtime**: Bun-native everything — `Bun.serve`, `Bun.file()`, `Bun.spawn`, `bun:sqlite`. No Node.js `fs` on the server side.
- **Auth**: Single admin token (`SHELLEPORT_ADMIN_TOKEN`). Bearer header for API, localStorage on the client. Timing-safe comparison via `timingSafeEqual`.
- **Packaging**: Ahead-of-time Bun fullstack bundle goes to `build/server`. Release binaries compiled with `Bun.build({ compile: ... })`; Bun embeds the HTML-imported frontend automatically.

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

- Browser shell comes from Bun HTML import. Client boot data comes from `/api/bootstrap`; live session data still comes from fetch + SSE after bootstrap.
- App routing is **owned locally**, not by a framework. Route matching lives in `src/client/routes.ts`; browser history plumbing lives in `src/client/router.tsx`.
- Main authenticated shell lives in `src/client/app-shell.tsx`. Login lives in `src/client/login-page.tsx`. Boot payload builder lives in `src/server/web.server.tsx`. HTML entry lives in `src/client/index.html`.
- State management is plain `useState` — no Redux, Zustand, or React Query.
- SSE messages: `snapshot` (full hydration), `session` (metadata update), `event` (append), `request` (approval flow).
- Tool calls are paired with their results via `toolUseId` for collapsible card rendering.

### Routes

| Path                   | Owner                       | Purpose                        |
| :--------------------- | :-------------------------- | :----------------------------- |
| `/`                    | `src/client/routes.ts`      | Main session shell             |
| `/sessions/:sessionId` | `src/client/routes.ts`      | Session detail shell           |
| `/archived`            | `src/client/routes.ts`      | Archived session list          |
| `/login`               | `src/client/routes.ts`      | Token login                    |
| `/logout`              | `server.ts`                 | Clear local token and redirect |
| `/api/*`               | `src/server/api.server.ts`  | API only                       |

When adding a new browser route, update `matchAppRoute()` in `src/client/routes.ts` and app rendering in `src/client/app.tsx`.

### Server layout

| File                                    | Responsibility                                       |
| :-------------------------------------- | :--------------------------------------------------- |
| `server.ts`                             | CLI entry point + Bun fullstack route wiring         |
| `src/server/web.server.tsx`             | Browser boot payload builder                         |
| `src/server/api.server.ts`              | HTTP request dispatcher for all `/api/*` routes      |
| `src/server/session-broker.server.ts`   | Session lifecycle, in-process pub/sub, approval flow |
| `src/server/store.server.ts`            | SQLite persistence (sessions, events, requests)      |
| `src/server/auth.server.ts`             | Bearer token auth only                               |
| `src/server/config.server.ts`           | Env var config                                       |
| `src/server/providers/claude.server.ts` | Claude Code adapter (live + historical)              |
| `src/server/providers/codex.server.ts`  | Codex adapter (historical import only)               |

### Build layout

| File                     | Responsibility                                 |
| :----------------------- | :--------------------------------------------- |
| `scripts/build.ts`       | Ahead-of-time Bun fullstack server bundle      |
| `scripts/package.ts`     | Compile local/release binaries                 |
| `scripts/npm-runtime.js` | Download correct release binary on npm install |
| `scripts/smoke.ts`       | Verify compiled binary serves fullstack app    |

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

## Bun bundler guardrails

- Bun owns browser assets. Do not reintroduce manual asset manifests, manual hashed filenames, or custom `/assets/client.js` serving.
- HTML entry owns browser assets. Keep stylesheet/script tags in `src/client/index.html`; do not move CSS ownership back into ad hoc server wiring.
- Tailwind requires Bun plugin wiring. Keep `[serve.static].plugins = ["bun-plugin-tailwind"]` in `bunfig.toml`. If CSS looks half-uncompiled, check this first.
- Dev path: `bun --hot server.ts serve` + `Bun.serve({ development: { hmr: true, console: true } })`. Do not build custom client watchers.
- Prod path: build first, then run built output from `build/server`. Do not run source directly for production.
- Packaging path: use `Bun.build({ compile: ... })` from `server.ts`. Let Bun embed HTML-imported frontend automatically.
- If using Bun HTML imports, prefer app routes + API endpoints through `Bun.serve` routes/fetch. Avoid parallel legacy serving paths.
- If changing build config, keep production explicit: `NODE_ENV=production`, minified build, Bun fullstack bundle.
- If changing client boot data, remember Bun HMR updates frontend modules, but already-mounted pages will not magically re-fetch `/api/bootstrap`. Refresh when validating server-only boot changes.
