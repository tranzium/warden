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
- Log On changes are not recorded in any audit log (consistent with other settings saves; only the agent-api surfaces — `/v1`, `/mcp`, and the dashboard's access-request approve/deny — are audited).
- The password crosses the wire once in the form post. Keep Warden on localhost, or behind TLS (`SECURE_COOKIES=true`), before using this remotely.
- The account check (`GET /services/:name/logon/lookup`, also `services.install`) resolves a name to `DOMAIN\name` via PowerShell. The account is passed as an environment variable, never interpolated into the script.

## The agent-restart API (`/v1/services/...`)

A second auth path, separate from the dashboard's session/Orbit auth: static bearer tokens in `AGENT_TOKENS_PATH` (default `./data/agent-tokens.json`, gitignored), each scoped to an allowlist of service names. Compared to the dashboard's `services.*` grants, this is narrower by design — a leaked token can only touch the specific services it was provisioned for, and never Taskflow's own rails or Warden itself (hardcoded denylist in `src/auth/agentTokens.ts`, enforced independent of the token file's contents). Treat a leaked token as compromise of whatever services it lists — provision one token per caller so a leak is scoped and auditable via `AGENT_AUDIT_LOG_PATH`.

A token's install/configure capability (`POST /v1/services`, `PATCH /v1/services/:name`) is off by default. A token file entry needs `canInstall: true` (provisioned with `bun run scripts/agent-token.ts add <name> <services> --can-install`) before either route will do anything; `isAllowedToInstall` in `src/auth/agentTokens.ts` then still requires the target service name to be on that token's allowlist and not denylisted — install/configure are not exempt from the existing per-service allowlist. Separately, and not configurable by the token file or the request body, both routes hardcode `forcedGroupName` / `requireGroupName` to the `agentic` group (`src/routes/agentApi.ts`) when calling the same `performInstall`/`performUpdate` cores the dashboard uses — so this path can install only into that one group, and can configure only services already in it, no matter what a misconfigured token or a crafted request body asks for. `performUpdate`'s `agentScoped` option additionally drops `hidden` and `managed` from an agent-gated configure request, silently — so neither `PATCH /v1/services/:name` nor the MCP `configure_service` tool can hide a service from the dashboard's default view/pulse counts or disable the dashboard's own start/stop/restart controls over it; the dashboard's own `PATCH /services/:name` is unaffected and still sets both fields.

A `canInstall: true` token remains SYSTEM-level remote-code-execution-equivalent for whatever service names it is provisioned for — same risk class as the dashboard's `services.install` (see Threat model above) — just fenced to one deliberately low-stakes group. Only provision `canInstall: true` for service names you would accept running arbitrary code as SYSTEM.

`POST /mcp` (the MCP server, `src/mcp/`) is the same capability over JSON-RPC, not a second permission model: it runs `agentAuthMiddleware` and its tools call the `/v1` handlers in `src/routes/agentApi.ts`, so the allowlist, denylist, `canInstall` gate, hardcoded `agentic` group, dry-run-by-default restart, and audit log are identical. Every audit entry carries `surface: "v1"`, `surface: "mcp"`, or `surface: "dashboard"` (the access-request approve/deny routes below, the only agent-api-adjacent actions a dashboard session rather than a bearer token can take); `/mcp` additionally audits `initialize`, `tools/list`, and every rejected envelope, method, or tool name (`action: "rpc_error"`, probed name in `detail`), so enumeration and probing leave a trace. There is no `Origin` check; a browser cannot attach the bearer token on its own, so DNS rebinding gains nothing without a leaked token.

### Self-service access requests (`/v1/access-requests`)

A token outside a service's allowlist can ask for it rather than the operator hand-editing `agent-tokens.json`: `POST /v1/access-requests` (body `{ service, reason? }`) queues a row in the `agent_access_requests` table; an operator with `services.install` approves or denies it from the dashboard. Two checks run before any row is ever written, never after: a denylisted target (`isDenylisted`) is refused immediately, and a target already on the caller's own allowlist is refused as redundant — neither reaches `createAccessRequest` (`src/routes/agentApi.ts`), so this path can only ever request a grant, never bypass the hardcoded denylist fence or short-circuit the allowlist. `GET /v1/access-requests` is scoped to the caller's own token name (`listAccessRequestsForToken`, `WHERE token_name = ?`) — one token can never see, or infer the existence of, another token's requests. Approval re-checks `isDenylisted` a second time at decision time (`src/routes/services.ts`'s `approveAccessRequestHandler`), independent of the up-front check, before calling `addServiceScope` — defense in depth against a row that somehow reached `pending` for a denylisted name despite the up-front guard. Approve/deny are dashboard-only, gated by `services.install` (the same grant as install/configure above) and audited with `surface: "dashboard"`; there is no MCP or `/v1` equivalent, so actually granting a scope always requires a human with dashboard access — a bearer token can request, never approve its own or anyone else's request.

This path only ever grants list/status/restart-level access — it must never reach `isAllowedToInstall`-level access. `addServiceScope` appends to the single `services` array a token carries, and `isAllowedToInstall` (`src/auth/agentTokens.ts`) grants install/configure over anything in that same array to a token with `canInstall: true`. So for a `canInstall` token, "restart scope" and "install/configure scope" are the same underlying grant — approving a plain restart request would also let that token install a brand-new service under the requested name, or configure it once tagged `group_name: agentic`. `approveAccessRequestHandler` therefore looks the requesting token up (`findTokenByName`) before calling `addServiceScope` and refuses outright, with a 400 and the row left `pending`, when the token carries `canInstall: true` — audited as `result: "can_install_blocked"`. The dashboard's pending-requests panel also flags any row from a `canInstall` token before the operator can click Approve. A deliberate grant for such a token is still possible, but only by hand, outside this flow, via `scripts/agent-token.ts`.

`addServiceScope` (`src/auth/agentTokens.ts`) is the only code path, besides hand-editing the file, that writes to `agent-tokens.json`: it reads the file, appends the service to the named token's entry (case-insensitive dedupe), and writes it back — same file, same no-caching behavior as the rest of this module, so a grant is live for the very next request with no Warden restart.

## The Orbit consent screen

`src/auth/consent.ts` is only reachable when `AUTH_MODE=orbit` **and** both `OAUTH_CONSENT_KEY` and `ORBIT_API_URL` are set — none of which are set by default. When active, it renders Warden's own login form for a *different* OAuth2 client's authorization request, takes the user's Orbit email and password, exchanges them with `ORBIT_API_URL/auth/login`, and signs the consent decision with the configured private key. This is Warden acting as Orbit's identity UI for third-party OAuth2 clients, not a normal login path — it is off by default and only relevant if you are running Warden as part of an Orbit deployment.

## Reporting a vulnerability

Email **security@wrift.ca** with a description and reproduction steps. Please don't open a public issue for undisclosed vulnerabilities.
