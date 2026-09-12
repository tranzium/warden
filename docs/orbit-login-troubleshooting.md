# Troubleshooting Orbit login failures

Symptoms this page covers:

- `Authentication failed: token was not accepted` (or one of the more specific variants below) after signing in through Orbit
- `Missing PKCE cookie — please try signing in again` on a retry

Both messages come from `callbackHandler` in [`src/routes/auth.ts`](../src/routes/auth.ts). The OAuth2 code exchange with orbit-oauth2 succeeded — the failure happens one step later, in Warden's call to `introspect()` ([`src/auth/orbit.ts`](../src/auth/orbit.ts)), which validates the access token against `ORBIT_INTROSPECT_URL` and fetches the user's grants.

## Step 1: run the preflight

```sh
bun run scripts/orbit-preflight.ts
```

This sends a deliberately invalid dummy token to Warden's own `ORBIT_INTROSPECT_URL` and reports which of the states below the deployment is in. It never prints the API key, an access token, or a cookie value.

## The three causes

`introspect()` now tags each failure and `callbackHandler` shows a distinct message for each. Server-side logs carry the same tag, prefixed `[orbit-introspect]`, with the HTTP status and a redacted response body — check `LOGS_DIR` / the service's stdout if the operator-facing message isn't enough.

### 1. `introspect-rejected-api-key` — HTTP 401

Warden's own `ORBIT_API_KEY` was rejected by orbit-introspect, or the control-plane tenant (`ORBIT_TENANT_ID`) is deactivated. This is a Warden-side credential problem, not the end user's.

Fix: confirm `ORBIT_API_KEY` in Warden's `.env` matches a live key for that tenant, and that the tenant is active.

### 2. `introspect-jwt-unconfigured` — HTTP 422

orbit-introspect's JWT verification path is not configured, so it can't validate any access token regardless of who's signing in. This is an Orbit-deployment problem, not a Warden problem — Warden isn't misconfigured here, Orbit's introspect service is.

On the Orbit box:

```sh
grep ORBIT_OAUTH_ISSUER /etc/orbit/orbit-service.env
grep ORBIT_OAUTH_ISSUER /etc/orbit/orbit-oauth2.env
```

Both `ORBIT_OAUTH_ISSUER` (and `JWKS_URL`) must be set in both files for the JWT path to be considered configured at all — if either is missing, introspect returns 422 regardless of the token presented.

After editing either file:

```sh
sudo systemctl restart orbit-introspect orbit-service
```

The JWT verifier is built once at process start, so a config edit with no restart has no effect.

Local orbit-introspect logs never print `(JWT verification enabled)` while this is broken — that log line's absence is itself diagnostic.

### 3. `token-rejected` — HTTP 200, `authenticated:false`

introspect ran the JWT path (so `ORBIT_OAUTH_ISSUER`/`JWKS_URL` are present) and rejected the token itself. Check the `denied_reason` field, included in the operator-facing message when present. Common causes:

- Issuer byte-mismatch between `orbit-service.env` and `orbit-oauth2.env` — must be **byte-identical**, including any trailing slash (e.g. `https://orbit.example.com` vs `https://orbit.example.com/`); fix on the Orbit box and restart both services as above
- Stale JWKS cached from before an orbit-oauth2 restart or key rotation — restart orbit-introspect to force a refetch
- Clock skew making a freshly issued token look expired or not-yet-valid

### 4. `introspect-unreachable`

Network failure calling `ORBIT_INTROSPECT_URL` — DNS, connection refused, timeout. Check the URL is correct and the box is up.

## The PKCE cookie retry artifact

`Missing PKCE cookie` is not one of the three causes above — it's what happens when `warden_pkce` (set in `src/auth/cookies.ts`) expires before the browser gets back to `/callback`. Its `Max-Age` is 900 seconds (15 minutes) as of this doc; spending longer than that on Orbit's login/consent screen, or reusing a stale tab from an earlier attempt, kills the cookie and produces this message on retry. It is a secondary symptom, not the root cause — if you see it, first rule out the real failure by signing in again promptly, and use the preflight/log tags above if the retry still fails.
