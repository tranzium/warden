import { parseCookies, verifySession, verifyPkce, signSession, signPkce, sessionCookie, clearSessionCookie, pkceCookie, clearPkceCookie } from '../auth/cookies'
import { buildAuthorizeUrl, exchangeCode, generatePkce } from '../auth/orbit'
import { loginPage } from '../views/login'
import { redirect } from '../shared/http'

export function loginHandler(req: Request): Response {
	// If already authenticated, redirect to dashboard
	const cookies = parseCookies(req)
	if (cookies.warden_session && verifySession(cookies.warden_session)) {
		return new Response(null, { status: 302, headers: { Location: '/' } })
	}
	return loginPage()
}

export async function loginStartHandler(): Promise<Response> {
	const { verifier, challenge } = await generatePkce()
	const state = crypto.randomUUID()
	const authorizeUrl = buildAuthorizeUrl(state, challenge)
	const cookie = pkceCookie(signPkce(verifier, state))
	return redirect(authorizeUrl, cookie)
}

export async function callbackHandler(req: Request): Promise<Response> {
	const url = new URL(req.url)
	const code = url.searchParams.get('code')
	const state = url.searchParams.get('state')
	const error = url.searchParams.get('error')

	if (error) {
		const desc = url.searchParams.get('error_description') ?? error
		return new Response(`Authentication failed: ${desc}`, { status: 400 })
	}

	if (!code || !state) {
		return new Response('Missing code or state parameter', { status: 400 })
	}

	// Verify PKCE state
	const cookies = parseCookies(req)
	const raw = cookies.warden_pkce
	if (!raw) {
		return new Response('Missing PKCE cookie — please try signing in again', { status: 400 })
	}

	const pkce = verifyPkce(raw)
	if (!pkce || pkce.state !== state) {
		return new Response('Invalid state — please try signing in again', { status: 400 })
	}

	// Exchange code for token
	const token = await exchangeCode(code, pkce.verifier)

	// Set session cookie, clear PKCE cookie, redirect to dashboard
	const headers = new Headers({ Location: '/' })
	headers.append('Set-Cookie', sessionCookie(signSession(token.access_token)))
	headers.append('Set-Cookie', clearPkceCookie())
	return new Response(null, { status: 302, headers })
}

export function logoutHandler(): Response {
	return redirect('/', clearSessionCookie())
}
