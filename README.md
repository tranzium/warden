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

Installed services' stdout/stderr logs default to `./logs` (`LOGS_DIR` in `.env`); change it if you'd rather keep them elsewhere.

To run Warden itself as a Windows service, see `nssm-install.bat` (edit the paths and secrets at the top before running as Administrator).

## Authentication

Warden ships with two auth modes, controlled by `AUTH_MODE`:

- **`local` (default)** — a single operator, credentials from `.env`, full permissions. No external dependency. This is what the quickstart above uses.
- **`orbit`** — delegates authentication and per-user, per-permission grants to an [Orbit](https://dash.wrift.ca/docs) tenant via OAuth2/PKCE, for teams that want multiple operators with different access levels. See [docs/orbit-setup.md](docs/orbit-setup.md) for the Warden-side wiring; Orbit's own docs cover account and tenant setup. If login fails after the Orbit redirect (e.g. "token was not accepted"), see [docs/orbit-login-troubleshooting.md](docs/orbit-login-troubleshooting.md) and run `bun run scripts/orbit-preflight.ts`.

## Agent-restart API

`POST /v1/services/:name/restart`, `GET /v1/services`, and `GET /v1/services/:name/status` are a second, minimal API surface for programmatic callers (e.g. an AI agent that needs to restart a service it just reconfigured) — separate from the dashboard's session/Orbit auth above.

- **Auth**: `Authorization: Bearer <token>`, checked against a token file — not a dashboard login or Orbit token.
- **Allowlist, not open**: each token maps to a fixed list of service names it may act on. A service outside that list (or not NSSM-managed) is refused. Taskflow's own rails (`tf-*`) and Warden itself are never restartable via this API, no matter what a token's config says.
- **Dry-run by default**: without `?live=1`, `restart` reports what would happen (authorized, exists, current status) but does not touch the service. Add `?live=1` to actually restart it.
- **Audit log**: every call — including auth failures — appends a JSON line to `AGENT_AUDIT_LOG_PATH` (default `./data/agent-audit.log`): timestamp, surface (`v1` or `mcp`), token name, action, service, result, HTTP status.

Provision a token:

```sh
bun run scripts/agent-token.ts add queen ear,ear-worker,herald,whisper,viz,bugle,yt
```

This prints the token once and writes it (in plaintext — the file is gitignored under `data/`) to `AGENT_TOKENS_PATH` (default `./data/agent-tokens.json`). Give the printed token only to the caller it's for; each caller should get its own token so the audit log attributes actions correctly. `bun run scripts/agent-token.ts list` shows provisioned tokens (without their secrets) and the services each is allowed to touch; `remove <name>` revokes one. Changes take effect immediately — no restart needed, the token file is re-read on every request.

Example call:

```sh
curl -H "Authorization: Bearer wat_..." -X POST "http://127.0.0.1:3004/v1/services/ear/restart?live=1"
```

## MCP server

`POST /mcp` exposes the same agent API as MCP tools (JSON-RPC over Streamable HTTP; JSON responses only, stateless, no SSE stream): `list_services`, `get_service_status`, `restart_service`, `configure_service`, `install_service`. It uses the same bearer tokens, allowlists, denylist, `canInstall` gate, hardcoded `agentic` group, and audit log as `/v1` — each tool calls the `/v1` handler code, so there is no separate permission model. `restart_service` is dry-run unless its arguments include `"live": true`.

Claude Code connection (`.mcp.json`), with the token taken from an environment variable — never commit a literal token:

```json
{
	"mcpServers": {
		"warden": {
			"type": "http",
			"url": "http://127.0.0.1:3004/mcp",
			"headers": { "Authorization": "Bearer ${WARDEN_AGENT_TOKEN}" }
		}
	}
}
```

Any other MCP client holds its own token the same way. Manual check:

```sh
curl -H "Authorization: Bearer wat_..." -H "Content-Type: application/json" http://127.0.0.1:3004/mcp -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_services","arguments":{}}}'
```

## Development

```sh
bun run test          # smoke tests: session/service-overlay roundtrips, schema migration
bunx tsc --noEmit      # typecheck
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for more.

## License

[MIT](LICENSE)
