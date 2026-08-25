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

## The Orbit consent screen

`src/auth/consent.ts` is only reachable when `AUTH_MODE=orbit` **and** both `OAUTH_CONSENT_KEY` and `ORBIT_API_URL` are set — none of which are set by default. When active, it renders Warden's own login form for a *different* OAuth2 client's authorization request, takes the user's Orbit email and password, exchanges them with `ORBIT_API_URL/auth/login`, and signs the consent decision with the configured private key. This is Warden acting as Orbit's identity UI for third-party OAuth2 clients, not a normal login path — it is off by default and only relevant if you are running Warden as part of an Orbit deployment.

## Reporting a vulnerability

Email **security@wrift.ca** with a description and reproduction steps. Please don't open a public issue for undisclosed vulnerabilities.
