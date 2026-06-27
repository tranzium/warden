import { parseCookies, verifySession, clearSessionCookie } from './cookies'
import { introspect } from './orbit'

export type AuthContext = {
	accessToken: string
	user: { id: string; email: string; name: string }
	grants: Record<string, boolean>
}

export async function authMiddleware(req: Request): Promise<AuthContext | Response> {
	let accessToken: string | undefined

	// Try Bearer header first (API clients), then session cookie (dashboard)
	const authHeader = req.headers.get('authorization')
	if (authHeader?.startsWith('Bearer ')) {
		accessToken = authHeader.slice(7)
	} else {
		const cookies = parseCookies(req)
		const raw = cookies.warden_session
		if (raw) accessToken = verifySession(raw) ?? undefined
	}

	if (!accessToken) return authError(req)

	const result = await introspect(accessToken)
	if (!result.authenticated || !result.user) {
		return authError(req, true)
	}

	return {
		accessToken,
		user: result.user,
		grants: result.grants ?? {},
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
