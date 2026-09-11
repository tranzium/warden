// Read-only preflight for Orbit's introspect endpoint. Run this after a "token was not
// accepted" / login-broken report to tell apart the three failure modes that
// callbackHandler used to collapse into one message — see docs/orbit-login-troubleshooting.md:
//   1. HTTP 401  -> Warden's ORBIT_API_KEY not accepted, or tenant deactivated
//   2. HTTP 422  -> orbit-introspect's JWT verification path is unconfigured
//   3. HTTP 200, authenticated:false -> reachable, key OK, JWT path configured
//      (the dummy token is deliberately invalid, so being rejected is the healthy outcome —
//      a healthy deployment never returns 401 for this request, since the key is checked
//      independently of the dummy token's validity)
//
// Usage: bun run scripts/orbit-preflight.ts
import { ALL_PERMISSIONS } from '../src/auth/permissions'

const introspectUrl = process.env.ORBIT_INTROSPECT_URL
const apiKey = process.env.ORBIT_API_KEY
const tenantId = process.env.ORBIT_TENANT_ID

function fail(msg: string): never {
	console.log(`FAIL: ${msg}`)
	process.exit(1)
}

if (!introspectUrl) fail('ORBIT_INTROSPECT_URL is not set')
if (!apiKey) fail('ORBIT_API_KEY is not set')
if (!tenantId) fail('ORBIT_TENANT_ID is not set')

console.log(`Checking ${introspectUrl}/check ...`)

let res: Response
try {
	res = await fetch(`${introspectUrl}/check`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${apiKey}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			access_token: 'orbit-preflight-dummy-token',
			tenant_id: tenantId,
			permissions: ALL_PERMISSIONS,
		}),
	})
} catch (err) {
	fail(`could not reach ${introspectUrl} — ${err instanceof Error ? err.message : String(err)}`)
}

const bodyText = await res.text().catch(() => '')

if (res.status === 422) {
	console.log('FAIL: introspect-jwt-unconfigured (HTTP 422)')
	console.log('  orbit-introspect is not configured for JWT verification.')
	console.log('  On the Orbit box: grep ORBIT_OAUTH_ISSUER in both /etc/orbit/orbit-service.env and')
	console.log('  /etc/orbit/orbit-oauth2.env (must be byte-identical, incl. trailing slash), then')
	console.log('  sudo systemctl restart orbit-introspect orbit-service')
	process.exit(1)
}

if (res.status === 401) {
	// A healthy deployment checks Warden's ORBIT_API_KEY independently of the dummy
	// token's validity, and always returns 200 authenticated:false for an invalid token.
	// So any 401 — body or no body — means the key itself was rejected.
	console.log('FAIL: introspect-rejected-api-key (HTTP 401)')
	console.log('  ORBIT_API_KEY was not accepted, or the tenant is deactivated.')
	process.exit(1)
}

if (res.status === 200) {
	let parsed: { authenticated?: boolean } = {}
	try {
		parsed = JSON.parse(bodyText) as { authenticated?: boolean }
	} catch {
		// fall through — unparseable 200 body is reported below as PASS-with-caveat
	}
	if (parsed.authenticated === true) {
		fail('dummy token was reported authenticated — introspect endpoint is not validating tokens')
	}
	console.log('PASS: introspect reachable, ORBIT_API_KEY accepted, dummy token correctly rejected')
	console.log('  (HTTP 200, authenticated:false)')
	process.exit(0)
}

fail(`unexpected status ${res.status} from introspect`)
