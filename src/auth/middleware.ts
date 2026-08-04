import { parseCookies, verifySession, clearSessionCookie } from './cookies'
import { introspect } from './orbit'
import { config } from '../shared/config'
import { getSession, touchSession, refreshSessionGrants, markSessionRefreshed } from '../db/client'

export type AuthContext = {
	accessToken: string
	user: { id: string; email: string; name: string }
	grants: Record<string, boolean>
}

export async function authMiddleware(req: Request): Promise<AuthContext | Response> {
	// Bearer header (API clients): only meaningful when an Orbit tenant can introspect it
	const authHeader = req.headers.get('authorization')
	if (authHeader?.startsWith('Bearer ')) {
		if (config.authMode !== 'orbit') return authError(req)
		const accessToken = authHeader.slice(7)
		const result = await introspect(accessToken)
		if (!result.authenticated || !result.user) return authError(req)
		return { accessToken, user: result.user, grants: result.grants ?? {} }
	}

	// Session cookie (dashboard): warden-side session, valid for SESSION_TTL_HOURS
	// with sliding expiry — independent of the Orbit access token lifetime
	const cookies = parseCookies(req)
	const raw = cookies.warden_session
	const sid = raw ? verifySession(raw) : null
	if (!sid) return authError(req)

	const session = getSession(sid)
	if (!session) return authError(req, true)

	let grants: Record<string, boolean>
	try {
		grants = JSON.parse(session.grants) as Record<string, boolean>
	} catch {
		grants = {}
	}

	// Re-introspect at most every 10 minutes to pick up grant changes while the
	// token is still valid; once it expires, cached grants carry the session.
	// Local sessions have no external grant source, so there's nothing to refresh.
	if (config.authMode === 'orbit' && session.stale) {
		const result = await introspect(session.access_token)
		if (result.authenticated && result.user) {
			grants = result.grants ?? {}
			refreshSessionGrants(sid, grants)
		} else {
			markSessionRefreshed(sid)
		}
	}

	touchSession(sid)

	return {
		accessToken: session.access_token,
		user: { id: session.user_id, email: session.email, name: session.name },
		grants,
	}
}

function authError(req: Request, clearCookie = false): Response {
	const accept = req.headers.get('accept') ?? ''
	if (accept.includes('application/json')) {
		return Response.json({ error: 'Unauthorized' }, { status: 401 })
	}
	const headers = new Headers({ Location: '/login' })
	if (clearCookie) headers.append('Set-Cookie', clearSessionCookie())
	return new Response(null, { status: 302, headers })
}

export function hasPermission(ctx: AuthContext, permission: string): boolean {
	return ctx.grants[permission] === true
}
