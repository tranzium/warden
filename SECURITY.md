# Security

## Threat model

Warden's `POST /services` (install) and the settings page install/reconfigure NSSM-managed Windows services. Because NSSM install/remove requires admin rights, Warden itself runs as **LocalSystem**, which means:

- `services.install` is remote code execution as SYSTEM — the holder can point a new service, or an existing one's settings, at any program path on the host.
- Every other `services.*` permission (start/stop/restart/logs/register) is scoped to services NSSM already knows about, but still operates with SYSTEM privileges.

This is the expected shape for an admin panel over a privileged subsystem — the alternative is giving every operator direct admin/RDP access to the host. The consequence is that **the login gate is the entire security boundary**. Treat any credential or session compromise as a SYSTEM compromise of the host.

### Mitigations already in place

- Every route past `/health` and `/static/` requires an authenticated session (`src/router.ts`, `src/auth/middleware.ts`).
- `HOST` defaults to `127.0.0.1` — Warden is not reachable from the network unless you deliberately widen it or put it behind a reverse proxy.
- Static file and log-viewer paths are resolved and checked against their base directory before serving (`src/router.ts`, `src/routes/logs.ts`) to block path traversal.
- Session and PKCE cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` when `SECURE_COOKIES=true` or `OAUTH_REDIRECT_URI` starts with `https://`. In `AUTH_MODE=local` (no `OAUTH_REDIRECT_URI`), set `SECURE_COOKIES=true` explicitly once you put Warden behind TLS — see `.env.example`.
- In `AUTH_MODE=local`, passwords are hashed with argon2id via `Bun.password` — never stored or compared in plaintext.

### Known gaps — mitigate before exposing beyond localhost

- **No CSRF token.** Mutating endpoints rely on `SameSite=Lax` cookies (blocks cross-site form POSTs from reaching them with credentials on a top-level navigation) plus a JSON `Content-Type` requirement on JSON-bodied routes. This is not a full CSRF defense. If you expose Warden to a network with other, less-trusted origins, put it behind a reverse proxy that adds a CSRF token or an authenticating proxy.
- **No login rate limiting or lockout**, in either auth mode. `AUTH_MODE=local` in particular is a single username/password pair with no brute-force protection — don't expose it to the internet without a reverse proxy that adds rate limiting (or switch to `AUTH_MODE=orbit` for a real identity provider in front of it).
- **`services.install` accepts any local path.** Warden does not sandbox or allowlist installable programs; anyone with that grant can run arbitrary code as SYSTEM by design (see Threat model above). Only grant it to operators you'd trust with admin on the box.

## Service Log On changes

The settings page can change the account a service runs as (NSSM `ObjectName`, services.msc "Log On").

- Gated by `services.install`, the same grant as the rest of the settings page. It adds no capability: that grant already allows running any program as SYSTEM.
- Refused for Warden itself, in the UI (read-only card) and on the server. Moving Warden off LocalSystem would break service install/remove.
- The password is passed to `nssm set <service> ObjectName <account> <password>`, so it is on that short-lived process's command line. Because Warden runs as LocalSystem, only administrators and SYSTEM can read it while it runs. It is **persisted** if the host enables process command-line auditing (Security event 4688 with `ProcessCreationIncludeCmdLine_Enabled`) or Sysmon/EDR command-line logging; neither was enabled on the reference host when checked (2026-11-11). Review this before enabling either.
- Windows stores the password as an LSA secret, the same as services.msc. Warden stores nothing: the password is not written to the DB, logs, error messages or redirect URLs, and is never rendered back into the page. NSSM output shown on failure has the password scrubbed.
- Log On changes are not recorded in any audit log (consistent with other settings saves; only the `/v1` agent API is audited).
- The password crosses the wire once in the form post. Keep Warden on localhost, or behind TLS (`SECURE_COOKIES=true`), before using this remotely.
- The account check (`GET /services/:name/logon/lookup`, also `services.install`) resolves a name to `DOMAIN\name` via PowerShell. The account is passed as an environment variable, never interpolated into the script.

## The agent-restart API (`/v1/services/...`)

A second auth path, separate from the dashboard's session/Orbit auth: static bearer tokens in `AGENT_TOKENS_PATH` (default `./data/agent-tokens.json`, gitignored), each scoped to an allowlist of service names. Compared to the dashboard's `services.*` grants, this is narrower by design — a leaked token can only touch the specific services it was provisioned for, and never Taskflow's own rails or Warden itself (hardcoded denylist in `src/auth/agentTokens.ts`, enforced independent of the token file's contents). Treat a leaked token as compromise of whatever services it lists — provision one token per caller so a leak is scoped and auditable via `AGENT_AUDIT_LOG_PATH`.

A token's install/configure capability (`POST /v1/services`, `PATCH /v1/services/:name`) is off by default. A token file entry needs `canInstall: true` (provisioned with `bun run scripts/agent-token.ts add <name> <services> --can-install`) before either route will do anything; `isAllowedToInstall` in `src/auth/agentTokens.ts` then still requires the target service name to be on that token's allowlist and not denylisted — install/configure are not exempt from the existing per-service allowlist. Separately, and not configurable by the token file or the request body, both routes hardcode `forcedGroupName` / `requireGroupName` to the `agentic` group (`src/routes/agentApi.ts`) when calling the same `performInstall`/`performUpdate` cores the dashboard uses — so this path can install only into that one group, and can configure only services already in it, no matter what a misconfigured token or a crafted request body asks for.

A `canInstall: true` token remains SYSTEM-level remote-code-execution-equivalent for whatever service names it is provisioned for — same risk class as the dashboard's `services.install` (see Threat model above) — just fenced to one deliberately low-stakes group. Only provision `canInstall: true` for service names you would accept running arbitrary code as SYSTEM.

`POST /mcp` (the MCP server, `src/mcp/`) is the same capability over JSON-RPC, not a second permission model: it runs `agentAuthMiddleware` and its tools call the `/v1` handlers in `src/routes/agentApi.ts`, so the allowlist, denylist, `canInstall` gate, hardcoded `agentic` group, dry-run-by-default restart, and audit log are identical. Audit entries do not record which of the two surfaces a call came through. There is no `Origin` check; a browser cannot attach the bearer token on its own, so DNS rebinding gains nothing without a leaked token.

## The Orbit consent screen

`src/auth/consent.ts` is only reachable when `AUTH_MODE=orbit` **and** both `OAUTH_CONSENT_KEY` and `ORBIT_API_URL` are set — none of which are set by default. When active, it renders Warden's own login form for a *different* OAuth2 client's authorization request, takes the user's Orbit email and password, exchanges them with `ORBIT_API_URL/auth/login`, and signs the consent decision with the configured private key. This is Warden acting as Orbit's identity UI for third-party OAuth2 clients, not a normal login path — it is off by default and only relevant if you are running Warden as part of an Orbit deployment.

## Reporting a vulnerability

Email **security@wrift.ca** with a description and reproduction steps. Please don't open a public issue for undisclosed vulnerabilities.
