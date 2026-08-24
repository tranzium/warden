# Warden

A small web dashboard for managing [NSSM](https://nssm.cc)-managed Windows services: start, stop, restart, install, and tail logs from a browser instead of `services.msc` or the command line.

Warden treats `nssm list` as the source of truth for which services exist. Its own SQLite database only stores a metadata overlay — display name, description, group, hidden/managed flags — so it never drifts out of sync with what's actually installed. A service that shows up via NSSM but has no metadata row just renders with sensible defaults; a metadata row with no live service renders as "Missing" until you clean it up.

## Before you install this

**Warden's `services.install` permission is remote code execution as SYSTEM.** NSSM install/remove requires admin, so Warden runs as LocalSystem, and the dashboard's "Install service" action lets an authorized user point that privilege at an arbitrary program path. This is the normal shape of an admin panel for a privileged subsystem, not a bug — but it means the login gate in front of it is the entire security boundary. Read [SECURITY.md](SECURITY.md) before exposing this beyond localhost.

## Quickstart

Requirements: [Bun](https://bun.sh), Windows, and [NSSM](https://nssm.cc) on `PATH` (or pointed to via `NSSM_PATH`).

> NSSM's stable release (2.24, from 2014) fails to start services on Windows 10's Creators Update and newer — use the [2.24-101 prerelease](https://nssm.cc/download) instead.

```sh
bun install
cp .env.example .env
```

Generate the two required secrets and drop them into `.env`:

```sh
bun run scripts/hash-password.ts <your-password>   # -> AUTH_PASSWORD_HASH="..."
```

`COOKIE_SECRET` just needs to be 32+ random characters (e.g. `openssl rand -hex 32`).

```sh
bun run start
```

Warden listens on `127.0.0.1:3004` by default — sign in with `AUTH_USERNAME` (default `admin`) and the password you hashed above.

To run Warden itself as a Windows service, see `nssm-install.bat` (edit the paths and secrets at the top before running as Administrator).

## Authentication

Warden ships with two auth modes, controlled by `AUTH_MODE`:

- **`local` (default)** — a single operator, credentials from `.env`, full permissions. No external dependency. This is what the quickstart above uses.
- **`orbit`** — delegates authentication and per-user, per-permission grants to an [Orbit](https://dash.wrift.ca/docs) tenant via OAuth2/PKCE, for teams that want multiple operators with different access levels. See [docs/orbit-setup.md](docs/orbit-setup.md) for the Warden-side wiring; Orbit's own docs cover account and tenant setup.

## Development

```sh
bun run test          # smoke tests: session/service-overlay roundtrips, schema migration
bunx tsc --noEmit      # typecheck
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for more.

## License

[MIT](LICENSE)
