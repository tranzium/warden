import { parseCookies, verifySession, verifyPkce, signSession, signPkce, sessionCookie, clearSessionCookie, pkceCookie, clearPkceCookie } from '../auth/cookies'
import { buildAuthorizeUrl, exchangeCode, introspect, generatePkce } from '../auth/orbit'
import { resolveChallenge, authenticateUser, signAndSubmitConsent } from '../auth/consent'
import { createSession, getSession, deleteSession } from '../db/client'
import { config } from '../shared/config'
import { loginPage } from '../views/login'
import { consentPage, consentErrorPage } from '../views/consent'
import { redirect } from '../shared/http'

export function loginHandler(req: Request): Response {
	// If already authenticated, redirect to dashboard
	const cookies = parseCookies(req)
	const sid = cookies.warden_session ? verifySession(cookies.warden_session) : null
	if (sid && getSession(sid)) {
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

	// Exchange code for token, then introspect once to seed the warden session
	const token = await exchangeCode(code, pkce.verifier)
	const result = await introspect(token.access_token)
	if (!result.authenticated || !result.user) {
		return new Response('Authentication failed: token was not accepted', { status: 400 })
	}

	const sid = createSession({
		accessToken: token.access_token,
		user: result.user,
		grants: result.grants ?? {},
	})

	// Set session cookie, clear PKCE cookie, redirect to dashboard
	const headers = new Headers({ Location: '/' })
	headers.append('Set-Cookie', sessionCookie(signSession(sid)))
	headers.append('Set-Cookie', clearPkceCookie())
	return new Response(null, { status: 302, headers })
}

export function logoutHandler(req: Request): Response {
	const cookies = parseCookies(req)
	const sid = cookies.warden_session ? verifySession(cookies.warden_session) : null
	if (sid) deleteSession(sid)
	return redirect('/', clearSessionCookie())
}

export async function consentGetHandler(req: Request): Promise<Response> {
	if (!config.oauthConsentKey || !config.orbitApiUrl) {
		return consentErrorPage('Consent flow not configured. Set OAUTH_CONSENT_KEY and ORBIT_API_URL.')
	}

	const url = new URL(req.url)
	const challengeId = url.searchParams.get('challenge')
	if (!challengeId) return consentErrorPage('Missing challenge parameter.')

	const challenge = await resolveChallenge(challengeId)
	if (!challenge) return consentErrorPage('Invalid or expired authorization challenge.')

	const scopes = challenge.scope.split(' ').filter(Boolean)
	return consentPage(challenge.client_name, scopes, challengeId)
}

export async function consentPostHandler(req: Request): Promise<Response> {
	if (!config.oauthConsentKey || !config.orbitApiUrl) {
		return consentErrorPage('Consent flow not configured.')
	}

	const form = await req.formData()
	const challengeId = String(form.get('challenge') ?? '')
	const decision = String(form.get('decision') ?? '')
	const email = String(form.get('email') ?? '')
	const password = String(form.get('password') ?? '')

	if (!challengeId) return consentErrorPage('Missing challenge.')

	const challenge = await resolveChallenge(challengeId)
	if (!challenge) return consentErrorPage('Invalid or expired authorization challenge.')
	const scopes = challenge.scope.split(' ').filter(Boolean)

	if (decision === 'deny') {
		// Subject is required by orbit-oauth2 even for denials; use a placeholder
		const result = await signAndSubmitConsent(challengeId, 'denied', challenge.scope, false)
		if (!result) return consentErrorPage('Failed to submit consent decision.')
		return new Response(null, { status: 302, headers: { Location: result.redirect_url } })
	}

	if (decision === 'approve') {
		if (!email || !password) {
			return consentPage(challenge.client_name, scopes, challengeId, 'Email and password are required.')
		}

		const user = await authenticateUser(email, password)
		if (!user) {
			return consentPage(challenge.client_name, scopes, challengeId, 'Invalid credentials.')
		}

		const result = await signAndSubmitConsent(challengeId, user.id, challenge.scope, true)
		if (!result) return consentErrorPage('Failed to submit consent. Please try again.')

		return new Response(null, { status: 302, headers: { Location: result.redirect_url } })
	}

	return consentErrorPage('Invalid decision.')
}
