import { config } from '../shared/config'

export interface ChallengeInfo {
	client_id: string
	client_name: string
	scope: string
	state: string | null
}

export interface ConsentUserInfo {
	id: string
	email: string
	name: string
}

function oauthBaseUrl(): string {
	return config.oauthAuthorizeUrl.replace(/\/oauth2\/authorize$/, '')
}

export async function resolveChallenge(challengeId: string): Promise<ChallengeInfo | null> {
	try {
		const res = await fetch(`${oauthBaseUrl()}/oauth2/challenges/${encodeURIComponent(challengeId)}`)
		if (!res.ok) return null
		return res.json() as Promise<ChallengeInfo>
	} catch {
		return null
	}
}

export async function authenticateUser(email: string, password: string): Promise<ConsentUserInfo | null> {
	if (!config.orbitApiUrl) return null

	try {
		const loginRes = await fetch(`${config.orbitApiUrl}/auth/login`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ email, password, tenant_id: config.orbitTenantId }),
		})
		if (!loginRes.ok) return null
		const loginData = await loginRes.json() as { token: string }

		const meRes = await fetch(`${config.orbitApiUrl}/auth/me`, {
			headers: { Authorization: `Bearer ${loginData.token}` },
		})
		if (!meRes.ok) return null
		const meData = await meRes.json() as { user: { id: string; email: string; name: string } }

		// Clean up temporary session (fire-and-forget)
		fetch(`${config.orbitApiUrl}/auth/logout`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${loginData.token}` },
		}).catch(() => {})

		return meData.user
	} catch {
		return null
	}
}

function sha512hex(raw: string): string {
	return new Bun.CryptoHasher('sha512').update(raw).digest('hex')
}

async function signCanonical(canonical: string, privateKey: JsonWebKey): Promise<string> {
	const msg = new TextEncoder().encode(canonical)
	const crv = (privateKey as any).crv as string

	let key: CryptoKey
	let algorithm: AlgorithmIdentifier

	if (crv === 'Ed25519') {
		key = await crypto.subtle.importKey('jwk', privateKey, 'Ed25519' as unknown as EcKeyImportParams, false, ['sign'])
		algorithm = 'Ed25519' as unknown as AlgorithmIdentifier
	} else {
		const hashMap: Record<string, string> = { 'P-256': 'SHA-256', 'P-384': 'SHA-384', 'P-521': 'SHA-512' }
		const hash = hashMap[crv]
		if (!hash) throw new Error(`Unsupported curve: ${crv}`)
		key = await crypto.subtle.importKey('jwk', privateKey, { name: 'ECDSA', namedCurve: crv }, false, ['sign'])
		algorithm = { name: 'ECDSA', hash }
	}

	const sig = new Uint8Array(await crypto.subtle.sign(algorithm, key, msg))
	return Array.from(sig).map(b => b.toString(16).padStart(2, '0')).join('')
}

export async function signAndSubmitConsent(
	challengeId: string,
	subject: string,
	scope: string,
	approved: boolean,
): Promise<{ redirect_url: string } | null> {
	if (!config.oauthConsentKey) return null

	const timestamp = Math.floor(Date.now() / 1000)
	const claimsHash = sha512hex('')
	const canonical = `${challengeId}:${subject}:${scope}:${approved ? 'true' : 'false'}:${timestamp}:${claimsHash}`

	try {
		const sig = await signCanonical(canonical, config.oauthConsentKey)

		const res = await fetch(`${oauthBaseUrl()}/oauth2/consent`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				challenge_id: challengeId,
				subject,
				scope,
				approved,
				claims: {},
				timestamp,
				sig,
			}),
		})

		if (!res.ok) {
			const body = await res.text()
			console.error(`Consent submission failed (${res.status}): ${body}`)
			return null
		}

		return res.json() as Promise<{ redirect_url: string }>
	} catch (e) {
		console.error('Consent error:', e)
		return null
	}
}
