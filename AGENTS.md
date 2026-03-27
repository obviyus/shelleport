# Project Information

- **Goal**: Browser-based control plane for host-local coding CLI agents. Start, monitor, and interact with AI coding sessions on any machine via a web UI or HTTP API.
- **Approach**: Bun-native fullstack bundler + Bun-native server/API path. Bun owns browser asset bundling; app owns client-side route matching/state after bootstrap. One Bun server path, one binary per platform.
- **UI Stack**: React 19 + React Compiler (useMemo/useCallback redundant), Tailwind CSS v4, shadcn/ui via `bunx shadcn@latest add ...`, lucide-react icons, motion v12 for animations.
- **Database**: `bun:sqlite` with WAL mode. Schema migrations are inline `ensureColumn()` calls, no migration framework. Data lives at `$XDG_DATA_HOME/shelleport/shelleport.sqlite`.
- **Runtime**: Bun-native everything — `Bun.serve`, `Bun.file()`, `Bun.spawn`, `bun:sqlite`. No Node.js `fs` on the server side.
- **Auth**: Single generated admin token, stored as hash only. Browser login exchanges token for HTTP-only session cookie. Bearer header still allowed for direct API callers.
- **Packaging**: Ahead-of-time client bundle goes to `build/client`. Release binaries compiled from `server.ts`; npm package is only an installer shell that downloads the matching native binary.

## Architecture

### Data flow

```
Browser ──fetch──► /api/* ──► api.server.ts ──► sessionBroker ──► provider (claude/codex)
   ▲                                                │
   └──────────── SSE stream ◄── publish() ◄─────────┘
```

- **SSE over fetch**, not EventSource. Manual `ReadableStream` parsing with `\n\n` delimiters.
- **In-process pub/sub** via module-level `Map<sessionId, Set<subscriber>>`. Single-process only, no external message queue.
- **Providers are async generators** — they yield `ProviderAdapterEvent` and the broker consumes with `for await`, writing to SQLite and fanning out to SSE subscribers.

### Key patterns

- Browser shell comes from Bun SSR in `src/server/web.server.tsx`. Client boot data is embedded into the HTML response; live session data still comes from fetch + SSE after bootstrap.
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
| `/logout`              | `src/server/web.server.tsx` | Clear auth cookie and redirect |
| `/api/*`               | `src/server/api.server.ts`  | API only                       |

When adding a new browser route, update `matchAppRoute()` in `src/client/routes.ts` and app rendering in `src/client/app.tsx`.

### Server layout

| File                                    | Responsibility                                       |
| :-------------------------------------- | :--------------------------------------------------- |
| `server.ts`                             | CLI entry point + Bun route wiring                   |
| `src/server/web.server.tsx`             | Browser SSR + boot payload builder                   |
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
| `scripts/build.ts`       | Ahead-of-time Bun browser bundle               |
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
- **Auth**: Browser path is cookie-auth. Direct API callers may use bearer auth. No localStorage auth. No extra auth variants.

## Bun bundler guardrails

- Bun owns browser assets. Do not reintroduce Vite or React Router build assumptions.
- Tailwind flows through Bun plugin wiring in `scripts/build.ts`. Do not reintroduce Tailwind CLI sidecars.
- Dev path: `bun --hot server.ts serve`. Do not build custom client watchers.
- Prod path: native binary or `bun run server.ts serve`; keep `NODE_ENV=production` explicit when validating prod behavior.
- Packaging path: `scripts/package.ts` compiles one native binary per target. npm package never ships the app logic; it installs the binary.
- If changing client boot data, remember SSR embeds boot state into HTML. Refresh when validating server-only boot changes.

## Release Workflow

- `0.0.1` claimed the npm name manually. Treat it as bootstrap, not the template for future releases.
- Future public releases are npm wrapper publishes plus matching GitHub binary assets.
- Release order:
  1. update `CHANGELOG.md` from the last tag (or from repo start if no tags yet)
  2. bump `package.json` version
  3. ALWAYS run `bun run check`, `bun test`, and `bun run smoke`
     After any release fix, rerun `bun run check`, `bun test`, and `bun run smoke` before retagging.
  4. ensure worktree clean except intended release files
  5. commit with conventional message
  6. create annotated tag `vX.Y.Z`
  7. push commit and tag
  8. let `.github/workflows/release.yml` build GitHub release assets and publish npm package
- Trusted publishing is the steady-state path. Manual `npm publish` was only for claiming the package name.
- Keep GitHub release tag, package version, and binary asset version identical.
- Do not publish npm first and binaries later. The npm installer expects the matching GitHub release assets to exist.
