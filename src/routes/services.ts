import { listServices, getService, registerService, unregisterService, updateService, type ServiceRow } from '../db/client'
import { nssmStatus, nssmStart, nssmStop, nssmRestart, isSelf, selfRestart, type ServiceState } from '../nssm/client'
import { type AuthContext, hasPermission } from '../auth/middleware'
import { ok, created, noContent, badRequest, forbidden, notFound, unprocessable } from '../shared/http'
import { dashboardPage, type ServiceView } from '../views/dashboard'
import { config } from '../shared/config'

async function enrichWithStatus(rows: ServiceRow[]): Promise<ServiceView[]> {
	const results = await Promise.all(
		rows.map(async (row): Promise<ServiceView> => {
			const status = row.managed ? await nssmStatus(row.name) : ('Unknown' as ServiceState)
			return {
				name: row.name,
				display: row.display,
				description: row.description,
				group_name: row.group_name,
				managed: !!row.managed,
				status,
			}
		}),
	)
	return results
}

export async function dashboardHandler(ctx: AuthContext): Promise<Response> {
	if (!hasPermission(ctx, 'services.view')) {
		return new Response(null, { status: 302, headers: { Location: '/login' } })
	}

	const rows = listServices()
	const services = await enrichWithStatus(rows)

	return dashboardPage(services, ctx.grants, {
		userName: ctx.user.email,
		grants: ctx.grants,
	})
}

export async function listHandler(ctx: AuthContext): Promise<Response> {
	if (!hasPermission(ctx, 'services.view')) return forbidden()

	const rows = listServices()
	const services = await enrichWithStatus(rows)

	const pulse = {
		total: services.length,
		running: services.filter(s => s.status === 'Running').length,
		stopped: services.filter(s => s.status === 'Stopped' || s.status === 'Unknown').length,
		other: 0,
	}
	pulse.other = pulse.total - pulse.running - pulse.stopped

	return ok({
		services,
		pulse,
		self: {
			name: config.wardenServiceName,
			uptime: Math.floor(process.uptime()),
			version: '0.1.0',
		},
	})
}

export function getHandler(ctx: AuthContext, name: string): Response {
	if (!hasPermission(ctx, 'services.view')) return forbidden()
	const row = getService(name)
	if (!row) return notFound(`Service '${name}' not found`)
	return ok(row)
}

export async function startHandler(ctx: AuthContext, name: string): Promise<Response> {
	if (!hasPermission(ctx, 'services.start')) return forbidden()
	const row = getService(name)
	if (!row) return notFound(`Service '${name}' not found`)
	if (!row.managed) return badRequest('Service is not managed')

	const result = await nssmStart(name)
	return ok({ action: 'start', service: name, ...result })
}

export async function stopHandler(ctx: AuthContext, name: string): Promise<Response> {
	if (!hasPermission(ctx, 'services.stop')) return forbidden()
	const row = getService(name)
	if (!row) return notFound(`Service '${name}' not found`)
	if (!row.managed) return badRequest('Service is not managed')

	if (isSelf(name)) return badRequest('Cannot stop warden from its own dashboard')

	const result = await nssmStop(name)
	return ok({ action: 'stop', service: name, ...result })
}

export async function restartHandler(ctx: AuthContext, name: string): Promise<Response> {
	if (!hasPermission(ctx, 'services.restart')) return forbidden()
	const row = getService(name)
	if (!row) return notFound(`Service '${name}' not found`)
	if (!row.managed) return badRequest('Service is not managed')

	// Self-restart: respond first, then exit
	if (isSelf(name)) {
		const response = ok({ action: 'restart', service: name, ok: true, output: 'Warden is restarting...' })
		selfRestart()
		return response
	}

	const result = await nssmRestart(name)
	return ok({ action: 'restart', service: name, ...result })
}

export async function registerHandler(ctx: AuthContext, req: Request): Promise<Response> {
	if (!hasPermission(ctx, 'services.register')) return forbidden()

	let body: Record<string, unknown>
	try {
		body = (await req.json()) as Record<string, unknown>
	} catch {
		return badRequest('Invalid JSON body')
	}

	const name = body.name
	if (typeof name !== 'string' || !name.trim()) {
		return unprocessable('name is required')
	}

	if (getService(name)) {
		return badRequest(`Service '${name}' already exists`)
	}

	const row = registerService({
		name: name.trim(),
		display: typeof body.display === 'string' ? body.display : undefined,
		description: typeof body.description === 'string' ? body.description : undefined,
		group_name: typeof body.group_name === 'string' ? body.group_name : undefined,
		managed: body.managed !== false,
	})

	return created(row)
}

export function unregisterHandler(ctx: AuthContext, name: string): Response {
	if (!hasPermission(ctx, 'services.register')) return forbidden()

	if (!unregisterService(name)) {
		return notFound(`Service '${name}' not found`)
	}

	return noContent()
}

export async function updateHandler(ctx: AuthContext, name: string, req: Request): Promise<Response> {
	if (!hasPermission(ctx, 'services.register')) return forbidden()

	if (!getService(name)) {
		return notFound(`Service '${name}' not found`)
	}

	let body: Record<string, unknown>
	try {
		body = (await req.json()) as Record<string, unknown>
	} catch {
		return badRequest('Invalid JSON body')
	}

	const row = updateService(name, {
		display: typeof body.display === 'string' ? body.display : body.display === null ? null : undefined,
		description: typeof body.description === 'string' ? body.description : body.description === null ? null : undefined,
		group_name: typeof body.group_name === 'string' ? body.group_name : body.group_name === null ? null : undefined,
		managed: typeof body.managed === 'boolean' ? body.managed : undefined,
	})

	return ok(row!)
}
