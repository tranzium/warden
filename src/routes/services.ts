import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { listServices, getService, unregisterService, upsertService } from '../db/client'
import {
	nssmStart,
	nssmStop,
	nssmRestart,
	nssmList,
	nssmInstall,
	nssmSet,
	nssmRemove,
	listWindowsServices,
	isSelf,
	selfRestart,
} from '../nssm/client'
import { type AuthContext, hasPermission } from '../auth/middleware'
import { ok, created, noContent, badRequest, forbidden, notFound, unprocessable, internalError } from '../shared/http'
import { dashboardPage, type ServiceView } from '../views/dashboard'
import { config } from '../shared/config'
import pkg from '../../package.json'

// Live truth: nssm list (membership) + one sc query (display + state).
// DB rows are a metadata overlay; rows without a live service render as Missing.
async function buildServices(): Promise<ServiceView[]> {
	const [nssmNames, winServices] = await Promise.all([nssmList(), listWindowsServices()])
	const winMap = new Map(winServices.map(w => [w.name.toLowerCase(), w]))
	const rowMap = new Map(listServices().map(r => [r.name.toLowerCase(), r]))

	const views: ServiceView[] = []
	const seen = new Set<string>()
	for (const name of nssmNames) {
		const key = name.toLowerCase()
		if (seen.has(key)) continue
		seen.add(key)
		const row = rowMap.get(key)
		const win = winMap.get(key)
		views.push({
			name,
			display: row?.display || win?.display || null,
			description: row?.description ?? null,
			group_name: row?.group_name ?? null,
			managed: row ? !!row.managed : true,
			hidden: row ? !!row.hidden : false,
			missing: false,
			status: win?.state ?? 'Unknown',
		})
	}
	for (const row of listServices()) {
		if (seen.has(row.name.toLowerCase())) continue
		views.push({
			name: row.name,
			display: row.display,
			description: row.description,
			group_name: row.group_name,
			managed: !!row.managed,
			hidden: !!row.hidden,
			missing: true,
			status: 'Unknown',
		})
	}
	views.sort((a, b) => (a.group_name ?? '').localeCompare(b.group_name ?? '') || a.name.localeCompare(b.name))
	return views
}

function buildPulse(services: ServiceView[]) {
	const visible = services.filter(s => !s.hidden)
	const pulse = {
		total: visible.length,
		running: visible.filter(s => s.status === 'Running').length,
		stopped: visible.filter(s => s.status === 'Stopped' || s.status === 'Unknown').length,
		other: 0,
	}
	pulse.other = pulse.total - pulse.running - pulse.stopped
	return pulse
}

export async function dashboardHandler(ctx: AuthContext): Promise<Response> {
	if (!hasPermission(ctx, 'services.view')) {
		return new Response(null, { status: 302, headers: { Location: '/login' } })
	}

	const services = await buildServices()

	return dashboardPage(services, ctx.grants, {
		userName: ctx.user.email,
		grants: ctx.grants,
	})
}

export async function listHandler(ctx: AuthContext): Promise<Response> {
	if (!hasPermission(ctx, 'services.view')) return forbidden()

	const services = await buildServices()

	return ok({
		services,
		pulse: buildPulse(services),
		self: {
			name: config.wardenServiceName,
			uptime: Math.floor(process.uptime()),
			version: pkg.version,
		},
	})
}

export async function getHandler(ctx: AuthContext, name: string): Promise<Response> {
	if (!hasPermission(ctx, 'services.view')) return forbidden()
	const services = await buildServices()
	const view = services.find(s => s.name.toLowerCase() === name.toLowerCase())
	if (!view) return notFound(`Service '${name}' not found`)
	return ok(view)
}

export async function startHandler(ctx: AuthContext, name: string): Promise<Response> {
	if (!hasPermission(ctx, 'services.start')) return forbidden()
	const row = getService(name)
	if (row && !row.managed) return badRequest('Service is not managed')

	const result = await nssmStart(name)
	return ok({ action: 'start', service: name, ...result })
}

export async function stopHandler(ctx: AuthContext, name: string): Promise<Response> {
	if (!hasPermission(ctx, 'services.stop')) return forbidden()
	const row = getService(name)
	if (row && !row.managed) return badRequest('Service is not managed')

	if (isSelf(name)) return badRequest('Cannot stop warden from its own dashboard')

	const result = await nssmStop(name)
	return ok({ action: 'stop', service: name, ...result })
}

export async function restartHandler(ctx: AuthContext, name: string): Promise<Response> {
	if (!hasPermission(ctx, 'services.restart')) return forbidden()
	const row = getService(name)
	if (row && !row.managed) return badRequest('Service is not managed')

	// Self-restart: respond first, then exit
	if (isSelf(name)) {
		const response = ok({ action: 'restart', service: name, ok: true, output: 'Warden is restarting...' })
		selfRestart()
		return response
	}

	const result = await nssmRestart(name)
	return ok({ action: 'restart', service: name, ...result })
}

const SERVICE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const START_MODES: Record<string, string> = {
	auto: 'SERVICE_AUTO_START',
	delayed: 'SERVICE_DELAYED_AUTO_START',
	manual: 'SERVICE_DEMAND_START',
	disabled: 'SERVICE_DISABLED',
}

function str(v: unknown): string | undefined {
	return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

export async function installHandler(ctx: AuthContext, req: Request): Promise<Response> {
	if (!hasPermission(ctx, 'services.install')) return forbidden()

	let body: Record<string, unknown>
	try {
		body = (await req.json()) as Record<string, unknown>
	} catch {
		return badRequest('Invalid JSON body')
	}

	const name = str(body.name)
	if (!name) return unprocessable('name is required')
	if (!SERVICE_NAME_RE.test(name)) {
		return unprocessable('Service name may only contain letters, digits, dot, underscore and hyphen')
	}

	const program = str(body.program)
	if (!program) return unprocessable('program is required')
	if (!(await Bun.file(program).exists())) {
		return unprocessable(`Program not found: ${program}`)
	}

	const start = str(body.start) ?? 'auto'
	const startMode = START_MODES[start]
	if (!startMode) return unprocessable(`start must be one of: ${Object.keys(START_MODES).join(', ')}`)

	const existing = await listWindowsServices()
	if (existing.some(w => w.name.toLowerCase() === name.toLowerCase())) {
		return badRequest(`A Windows service named '${name}' already exists`)
	}

	const stdout = str(body.stdout) ?? join(config.logsDir, name, 'stdout.log')
	const stderr = str(body.stderr) ?? join(config.logsDir, name, 'stderr.log')

	// NSSM creates log files but not missing directories
	try {
		mkdirSync(dirname(stdout), { recursive: true })
		mkdirSync(dirname(stderr), { recursive: true })
	} catch (e) {
		return internalError(`Failed to create log directory: ${e instanceof Error ? e.message : String(e)}`)
	}

	const install = await nssmInstall(name, program)
	if (!install.ok) return badRequest(`Install failed: ${install.output}`)

	const settings: Array<[string, string]> = []
	const args = str(body.args)
	if (args) settings.push(['AppParameters', args])
	const directory = str(body.directory)
	if (directory) settings.push(['AppDirectory', directory])
	const display = str(body.display)
	if (display) settings.push(['DisplayName', display])
	const description = str(body.description)
	if (description) settings.push(['Description', description])
	settings.push(
		['Start', startMode],
		['AppStdout', stdout],
		['AppStderr', stderr],
		// Fixed policy: throttle-matched restart delay and always-on 1 MB log rotation
		['AppRestartDelay', '1500'],
		['AppRotateFiles', '1'],
		['AppRotateOnline', '1'],
		['AppRotateBytes', '1048576'],
	)

	for (const [param, value] of settings) {
		const result = await nssmSet(name, param, value)
		if (!result.ok) {
			// Creation is atomic: any failed set rolls the whole install back
			await nssmRemove(name)
			return badRequest(`Failed to set ${param}: ${result.output || 'unknown error'} — installation rolled back`)
		}
	}

	const row = upsertService(name, {
		description: description ?? null,
		group_name: str(body.group_name) ?? null,
		managed: true,
		hidden: false,
	})

	return created({ service: name, installed: true, row })
}

export async function uninstallHandler(ctx: AuthContext, name: string): Promise<Response> {
	if (!hasPermission(ctx, 'services.install')) return forbidden()
	if (isSelf(name)) return badRequest('Cannot uninstall warden from its own dashboard')

	const nssmNames = await nssmList()
	const actual = nssmNames.find(n => n.toLowerCase() === name.toLowerCase())
	if (!actual) return notFound(`'${name}' is not an NSSM service`)

	await nssmStop(actual) // best effort; already-stopped is fine
	const result = await nssmRemove(actual)
	if (!result.ok) return badRequest(`Uninstall failed: ${result.output}`)

	unregisterService(actual)
	return ok({ action: 'uninstall', service: actual, ok: true })
}

// Removes a Missing orphan's metadata row; live services must be uninstalled instead
export async function unregisterHandler(ctx: AuthContext, name: string): Promise<Response> {
	if (!hasPermission(ctx, 'services.register')) return forbidden()

	if (!getService(name)) return notFound(`Service '${name}' not found`)

	const nssmNames = await nssmList()
	if (nssmNames.some(n => n.toLowerCase() === name.toLowerCase())) {
		return badRequest('Service is still installed — use uninstall instead')
	}

	unregisterService(name)
	return noContent()
}

export async function updateHandler(ctx: AuthContext, name: string, req: Request): Promise<Response> {
	if (!hasPermission(ctx, 'services.register')) return forbidden()

	let body: Record<string, unknown>
	try {
		body = (await req.json()) as Record<string, unknown>
	} catch {
		return badRequest('Invalid JSON body')
	}

	// Metadata is an overlay: editing a service without a row creates one,
	// but only for services that actually exist (or already have a row)
	if (!getService(name)) {
		const nssmNames = await nssmList()
		if (!nssmNames.some(n => n.toLowerCase() === name.toLowerCase())) {
			return notFound(`Service '${name}' not found`)
		}
	}

	const row = upsertService(name, {
		display: typeof body.display === 'string' ? body.display : body.display === null ? null : undefined,
		description: typeof body.description === 'string' ? body.description : body.description === null ? null : undefined,
		group_name: typeof body.group_name === 'string' ? body.group_name : body.group_name === null ? null : undefined,
		managed: typeof body.managed === 'boolean' ? body.managed : undefined,
		hidden: typeof body.hidden === 'boolean' ? body.hidden : undefined,
	})

	return ok(row)
}
