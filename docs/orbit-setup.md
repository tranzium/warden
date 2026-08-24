# Wiring Warden to Orbit

This page covers only the Warden side: which environment variables it reads and what it expects an Orbit tenant/OAuth2 client to be configured with. For creating an Orbit account, tenant, and OAuth2 client, see [Orbit's docs](https://dash.wrift.ca/docs) — that setup lives entirely in Orbit and can change independently of Warden.

Set `AUTH_MODE=orbit` to enable this path; it's off by default (see [README.md](../README.md#authentication)).

## What Warden needs from your Orbit tenant

| Warden env var | What it is |
|---|---|
| `ORBIT_INTROSPECT_URL` | Base URL of `orbit-introspect`; Warden POSTs to `{url}/check` to validate access tokens and fetch grants. |
| `ORBIT_API_KEY` | API key for the control-plane tenant, sent as `Authorization: Bearer` on introspect calls. |
| `ORBIT_TENANT_ID` | The tenant UUID introspection checks grants against. |
| `OAUTH_CLIENT_ID` | The OAuth2 client ID Orbit issued for this Warden instance. |
| `OAUTH_CLIENT_SECRET` | Leave empty for a public client (Warden uses PKCE); set if your client is confidential. |
| `OAUTH_REDIRECT_URI` | Must exactly match a redirect URI registered on the OAuth2 client. Warden serves `GET /callback` at this path. |
| `OAUTH_AUTHORIZE_URL` / `OAUTH_TOKEN_URL` | The tenant's `/oauth2/authorize` and `/oauth2/token` endpoints. |
| `ORBIT_API_URL` | Optional — only needed if Warden hosts its own consent screen (see below). |
| `OAUTH_CONSENT_KEY` | Optional — private JWK for signing consent decisions. Only set this if you're intentionally running Warden as the consent UI for an Orbit OAuth2 client; see the "Orbit consent screen" section in [SECURITY.md](../SECURITY.md). Most deployments should leave this unset and let Orbit host its own consent screen. |

## Permissions Warden checks

Grant these on the OAuth2 client / tenant per user, as needed — Warden hides any UI action the current session's grants don't cover:

```
services.view
services.start
services.stop
services.restart
services.register   # edit metadata: display name, description, group, hidden flag
services.install     # install/uninstall/reconfigure services — SYSTEM-level, grant carefully
services.logs
```

`services.view` is required to load the dashboard at all.

## Generating a consent signing key (optional)

Only needed if you're hosting Warden's own consent screen (`OAUTH_CONSENT_KEY` set):

```sh
bun scripts/gen-consent-keys.ts
```

This prints a private JWK (goes in `OAUTH_CONSENT_KEY`) and a public JWK to register with the OAuth2 client as its `consent_jwk`.
