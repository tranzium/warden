import { resolve } from 'node:path'
import { authMiddleware } from './auth/middleware'
import { loginHandler, loginStartHandler, callbackHandler, logoutHandler, consentGetHandler, consentPostHandler } from './routes/auth'
import { dashboardHandler, listHandler, getHandler, startHandler, stopHandler, restartHandler, registerHandler, unregisterHandler, updateHandler, availableHandler } from './routes/services'
import { html404 } from './views/html'

const staticDir = resolve(import.meta.dir, '..', 'static')

export async function router(req: Request): Promise<Response> {
	const url = new URL(req.url)
	const { pathname } = url
	const method = req.method

	// Health check — no auth
	if (pathname === '/health' && method === 'GET') {
		return Response.json({ ok: true, uptime: Math.floor(process.uptime()) })
	}

	// Static files — no auth
	if (pathname.startsWith('/static/')) {
		const filePath = resolve(staticDir, pathname.slice('/static/'.length))
		if (!filePath.startsWith(staticDir + '/') && !filePath.startsWith(staticDir + '\\')) return new Response('Forbidden', { status: 403 })
		const file = Bun.file(filePath)
		if (await file.exists()) return new Response(file)
		return new Response('Not found', { status: 404 })
	}

	// Auth routes — no auth required
	if (pathname === '/login' && method === 'GET') return loginHandler(req)
	if (pathname === '/login/start' && method === 'GET') return loginStartHandler()
	if ((pathname === '/login/consent' || pathname === '/login/consent/') && method === 'GET') return consentGetHandler(req)
	if ((pathname === '/login/consent' || pathname === '/login/consent/') && method === 'POST') return consentPostHandler(req)
	if (pathname === '/callback' && method === 'GET') return callbackHandler(req)
	if (pathname === '/logout' && method === 'POST') return logoutHandler(req)

	// Authenticated routes
	const authResult = await authMiddleware(req)
	if (authResult instanceof Response) return authResult
	const ctx = authResult

	// Dashboard
	if (pathname === '/' && method === 'GET') return dashboardHandler(ctx)

	// Services JSON API
	if (pathname === '/services' && method === 'GET') return listHandler(ctx)
	if (pathname === '/services' && method === 'POST') return registerHandler(ctx, req)
	if (pathname === '/services/available' && method === 'GET') return availableHandler(ctx)

	const serviceMatch = pathname.match(/^\/services\/([^/]+)(\/.*)?$/)
	if (serviceMatch) {
		const name = decodeURIComponent(serviceMatch[1]!)
		const sub = serviceMatch[2] ?? ''

		if (sub === '' && method === 'GET') return getHandler(ctx, name)
		if (sub === '' && method === 'DELETE') return unregisterHandler(ctx, name)
		if (sub === '' && method === 'PATCH') return updateHandler(ctx, name, req)
		if (sub === '/start' && method === 'POST') return startHandler(ctx, name)
		if (sub === '/stop' && method === 'POST') return stopHandler(ctx, name)
		if (sub === '/restart' && method === 'POST') return restartHandler(ctx, name)
	}

	return html404()
}
