import { createHmac, timingSafeEqual } from 'node:crypto'
import { config } from '../shared/config'

export function parseCookies(req: Request): Record<string, string> {
	const header = req.headers.get('cookie') ?? ''
	return Object.fromEntries(
		header
			.split(';')
			.map(s => s.trim())
			.filter(Boolean)
			.map(s => {
				const eq = s.indexOf('=')
				return eq === -1 ? [s, ''] : [s.slice(0, eq), s.slice(eq + 1)]
			}),
	)
}

function hmac(data: string): string {
	return createHmac('sha256', config.cookieSecret).update(data).digest('hex')
}

function encode(payload: unknown): string {
	return Buffer.from(JSON.stringify(payload)).toString('base64url')
}

function decode(encoded: string): unknown {
	try {
		return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
	} catch {
		return null
	}
}

function sign(payload: unknown): string {
	const encoded = encode(payload)
	return `${encoded}.${hmac(encoded)}`
}

function verify(value: string): unknown {
	const dot = value.lastIndexOf('.')
	if (dot === -1) return null
	const encoded = value.slice(0, dot)
	const sig = value.slice(dot + 1)
	const expected = Buffer.from(hmac(encoded), 'hex')
	const actual = Buffer.from(sig, 'hex')
	if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null
	return decode(encoded)
}

// Session cookie: stores the OAuth2 access token
export function signSession(accessToken: string): string {
	return sign({ t: 's', token: accessToken })
}

export function verifySession(value: string): string | null {
	const data = verify(value)
	if (
		data !== null &&
		typeof data === 'object' &&
		(data as Record<string, unknown>).t === 's' &&
		typeof (data as Record<string, unknown>).token === 'string'
	) {
		return (data as { token: string }).token
	}
	return null
}

// PKCE cookie: stores code_verifier + state during OAuth2 flow
export function signPkce(verifier: string, state: string): string {
	return sign({ t: 'p', v: verifier, s: state })
}

export function verifyPkce(value: string): { verifier: string; state: string } | null {
	const data = verify(value)
	if (
		data !== null &&
		typeof data === 'object' &&
		(data as Record<string, unknown>).t === 'p' &&
		typeof (data as Record<string, unknown>).v === 'string' &&
		typeof (data as Record<string, unknown>).s === 'string'
	) {
		const d = data as { v: string; s: string }
		return { verifier: d.v, state: d.s }
	}
	return null
}

const secureSuffix = config.secure ? '; Secure' : ''

export function sessionCookie(value: string): string {
	return `warden_session=${value}; HttpOnly; SameSite=Lax; Path=/${secureSuffix}`
}

export function clearSessionCookie(): string {
	return `warden_session=; Max-Age=0; HttpOnly; SameSite=Lax; Path=/${secureSuffix}`
}

export function pkceCookie(value: string): string {
	return `warden_pkce=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=300${secureSuffix}`
}

export function clearPkceCookie(): string {
	return `warden_pkce=; Max-Age=0; HttpOnly; SameSite=Lax; Path=/${secureSuffix}`
}
