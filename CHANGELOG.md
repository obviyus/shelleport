# Changelog

## 0.0.8 - 2026-03-27

- seed the admin token in `web.server` tests so clean CI environments authenticate the same way local runs do

## 0.0.7 - 2026-03-27

- fix release binaries to serve the same Bun browser-build assets as dev, including Tailwind CSS
- add runtime install progress and clickable startup URL output
- harden auth with one-time generated admin token, hash-only storage, separate session cookie, and `shelleport token`
- remove the `SHELLEPORT_ADMIN_TOKEN` env path; single auth model only

## 0.0.6 - 2026-03-27

- restore `sessionBroker` methods in `web.server` tests so file order in CI no longer poisons API tests

## 0.0.5 - 2026-03-27

- auto-install the native runtime on first CLI run when the package manager skipped the install hook

## 0.0.4 - 2026-03-27

- fix GitHub Actions to use `bun run check` and `bun run test`, so tag builds honor the serialized test runner

## 0.0.3 - 2026-03-27

- run tests with `--max-concurrency 1` so singleton/env-coupled server tests behave deterministically in CI

## 0.0.2 - 2026-03-27

First real public release.

- Bun-native fullstack runtime and native binary packaging
- npm wrapper package that installs the matching platform binary
- Bun SSR with embedded boot data and cookie-based browser auth
- browser session control plane with SSE streaming, approvals, archive, uploads, and launcher UI
- GitHub Actions for `main` CI and tag-based release publishing

## 0.0.1 - 2026-03-27

Bootstrap npm publish to claim the `shelleport` package name.
