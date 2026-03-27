# Changelog

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
