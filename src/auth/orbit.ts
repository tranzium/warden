import { config } from '../shared/config'
import { ALL_PERMISSIONS } from './permissions'

// Canonical tags for callbackHandler's three collapsed-into-one-message failure modes
// (see docs/orbit-login-troubleshooting.md). Keep in sync with describeIntrospectFailure below.
export type IntrospectFailureReason =
	| 'unreachable' // network error / no response — orbit-introspect down or URL wrong
	| 'rejected-api-key' // HTTP 401 — Warden's ORBIT_API_KEY not accepted, or tenant deactivated
	| 'jwt-unconfigured' // HTTP 422 — orbit-introspect's JWT verification path is not configured
	| 'token-rejected' // HTTP 200, authenticated:false — JWT verification ran and failed
	| 'error' // any other non-2xx status

export interface IntrospectResult {
	authenticated: boolean
	user?: { id: string; email: string; name: string }
	grants?: Record<string, boolean>
	denied_reason?: string
	failureReason?: IntrospectFailureReason
	status?: number
}

export interface TokenResult {
	access_token: string
	token_type: string
	expires_in: number
	scope: string
}

// Strips long token-shaped substrings from a response body before it hits a log line.
// Never log or echo the access token, API key, or cookie values.
function redactBody(body: string): string {
	const truncated = body.length > 500 ? `${body.slice(0, 500)}…(truncated)` : body
	return truncated.replace(/[A-Za-z0-9_-]{20,}/g, '[redacted]')
}

function logIntrospectFailure(tag: string, detail: Record<string, unknown>): void {
	console.error(`[orbit-introspect] ${tag}`, detail)
}

export async function introspect(accessToken: string): Promise<IntrospectResult> {
	let res: Response
	try {
		res = await fetch(`${config.orbitIntrospectUrl}/check`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${config.orbitApiKey}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				access_token: accessToken,
				tenant_id: config.orbitTenantId,
				permissions: ALL_PERMISSIONS,
			}),
		})
	} catch (err) {
		logIntrospectFailure('introspect-unreachable', { error: err instanceof Error ? err.message : String(err) })
		return { authenticated: false, failureReason: 'unreachable' }
	}

	if (!res.ok) {
		const body = redactBody(await res.text().catch(() => ''))
		if (res.status === 401) {
			logIntrospectFailure('introspect-rejected-api-key', { status: res.status, body })
			return { authenticated: false, failureReason: 'rejected-api-key', status: res.status }
		}
		if (res.status === 422) {
			logIntrospectFailure('introspect-jwt-unconfigured', { status: res.status, body })
			return { authenticated: false, failureReason: 'jwt-unconfigured', status: res.status }
		}
		logIntrospectFailure('introspect-error', { status: res.status, body })
		return { authenticated: false, failureReason: 'error', status: res.status }
	}

	const result = (await res.json()) as IntrospectResult
	if (!result.authenticated) {
		logIntrospectFailure('introspect-token-rejected', { status: res.status, denied_reason: result.denied_reason })
		return { ...result, failureReason: 'token-rejected', status: res.status }
	}
	return result
}

// Operator-facing message for callbackHandler — never includes the token, API key, or cookie values.
export function describeIntrospectFailure(result: IntrospectResult): string {
	switch (result.failureReason) {
		case 'unreachable':
			return 'Authentication failed: could not reach the Orbit introspection service (ORBIT_INTROSPECT_URL). See docs/orbit-login-troubleshooting.md.'
		case 'rejected-api-key':
			return "Authentication failed: Warden's Orbit API key was not accepted (401). Check ORBIT_API_KEY and tenant status — see docs/orbit-login-troubleshooting.md."
		case 'jwt-unconfigured':
			return 'Authentication failed: Orbit introspection is not configured for JWT verification (422). See docs/orbit-login-troubleshooting.md.'
		case 'token-rejected':
			return `Authentication failed: token was not accepted${result.denied_reason ? ` (${result.denied_reason})` : ''}.`
		default:
			return 'Authentication failed: token was not accepted.'
	}
}

export async function exchangeCode(code: string, codeVerifier: string): Promise<TokenResult> {
	const params = new URLSearchParams({
		grant_type: 'authorization_code',
		code,
		redirect_uri: config.oauthRedirectUri,
		code_verifier: codeVerifier,
		client_id: config.oauthClientId,
	})

	const headers: Record<string, string> = {
		'Content-Type': 'application/x-www-form-urlencoded',
	}
	if (config.oauthClientSecret) {
		headers.Authorization = `Basic ${btoa(`${config.oauthClientId}:${config.oauthClientSecret}`)}`
	}

	const res = await fetch(config.oauthTokenUrl, {
		method: 'POST',
		headers,
		body: params.toString(),
	})

	if (!res.ok) {
		const body = await res.text()
		throw new Error(`Token exchange failed (${res.status}): ${body}`)
	}

	return res.json() as Promise<TokenResult>
}

export function buildAuthorizeUrl(state: string, codeChallenge: string): string {
	const params = new URLSearchParams({
		client_id: config.oauthClientId,
		redirect_uri: config.oauthRedirectUri,
		response_type: 'code',
		code_challenge: codeChallenge,
		code_challenge_method: 'S256',
		scope: 'openid services',
		state,
	})
	return `${config.oauthAuthorizeUrl}?${params}`
}

export async function generatePkce(): Promise<{ verifier: string; challenge: string }> {
	const bytes = new Uint8Array(32)
	crypto.getRandomValues(bytes)
	const verifier = Buffer.from(bytes).toString('base64url')
	const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
	const challenge = Buffer.from(hash).toString('base64url')
	return { verifier, challenge }
}
