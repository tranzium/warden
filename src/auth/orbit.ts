import { config } from '../shared/config'

export interface IntrospectResult {
	authenticated: boolean
	user?: { id: string; email: string; name: string }
	grants?: Record<string, boolean>
	denied_reason?: string
}

export interface TokenResult {
	access_token: string
	token_type: string
	expires_in: number
	scope: string
}

const ALL_PERMISSIONS = [
	'services.view',
	'services.start',
	'services.stop',
	'services.restart',
	'services.register',
]

export async function introspect(accessToken: string): Promise<IntrospectResult> {
	const res = await fetch(`${config.orbitIntrospectUrl}/check`, {
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

	if (!res.ok) {
		return { authenticated: false, denied_reason: 'unauthenticated' }
	}

	return res.json() as Promise<IntrospectResult>
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
