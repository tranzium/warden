# Contributing

## Setup

```sh
bun install
cp .env.example .env
bun run scripts/hash-password.ts <password>   # paste the AUTH_PASSWORD_HASH line into .env
bun run start
```

Requires Windows + [NSSM](https://nssm.cc) on `PATH` to exercise the service-control routes end to end. The smoke tests (below) don't need either.

## Before opening a PR

```sh
bunx tsc --noEmit
bun run test
```

`bun run test` runs `scripts/smoke.ts` and `scripts/smoke-migrate.ts` — ad-hoc scripts that boot the module graph against a temp SQLite DB and exercise the session and service-overlay roundtrips, plus the guarded schema migration path. There's no NSSM interaction in either, so they run without Windows or NSSM installed.

## Style

- Tabs for indentation, no semicolons, single quotes — match the existing code, there's no separate linter config to defer to.
- Don't add comments that restate what the code does. A comment earns its place by explaining a non-obvious *why* (a workaround, an invariant, a constraint from NSSM or the browser) — see the existing codebase for the bar.
- Keep changes scoped. This is a small, single-purpose tool; prefer a few focused commits over one that touches everything.

## Reporting bugs

Open a GitHub issue with repro steps. For anything that looks like a security issue (privilege escalation, auth bypass, path traversal), see [SECURITY.md](SECURITY.md) instead — don't file it publicly.
