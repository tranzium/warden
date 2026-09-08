import { resolveAgentToken, isDenylisted, type AgentToken } from '../auth/agentTokens'
import { auditLog } from '../auth/agentAudit'
import { nssmList, nssmStatus, nssmRestart } from '../nssm/client'
import { ok, forbidden, notFound, unauthorized } from '../shared/http'

const SERVICE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export async function agentAuthMiddleware(req: Request): Promise<AgentToken | Response> {
	const header = req.headers.get('authorization')
	if (!header?.startsWith('Bearer ')) {
		auditLog({ token: 'none', action: 'auth', service: null, result: 'missing_token', status: 401 })
		return unauthorized('Missing bearer token')
	}

	const raw = header.slice(7).trim()
	const caller = raw ? resolveAgentToken(raw) : null
	if (!caller) {
		auditLog({ token: 'unknown', action: 'auth', service: null, result: 'invalid_token', status: 401 })
		return unauthorized('Invalid bearer token')
	}
	return caller
}

function isAllowed(caller: AgentToken, name: string): boolean {
	if (isDenylisted(name)) return false
	return caller.services.some(s => s.toLowerCase() === name.toLowerCase())
}

// Lists only the services this token is allowlisted for, not every NSSM service on the box.
export async function agentListHandler(caller: AgentToken): Promise<Response> {
	const nssmNames = await nssmList()
	const live = new Set(nssmNames.map(n => n.toLowerCase()))

	const services = []
	for (const name of caller.services) {
		if (isDenylisted(name)) continue
		const exists = live.has(name.toLowerCase())
		services.push({ name, exists, status: exists ? await nssmStatus(name) : 'Unknown' })
	}

	auditLog({ token: caller.name, action: 'list', service: null, result: 'ok', status: 200 })
	return ok({ services })
}

export async function agentStatusHandler(caller: AgentToken, name: string): Promise<Response> {
	if (!SERVICE_NAME_RE.test(name) || !isAllowed(caller, name)) {
		auditLog({ token: caller.name, action: 'status', service: name, result: 'forbidden', status: 403 })
		return forbidden(`Not authorized for service '${name}'`)
	}

	const nssmNames = await nssmList()
	if (!nssmNames.some(n => n.toLowerCase() === name.toLowerCase())) {
		auditLog({ token: caller.name, action: 'status', service: name, result: 'not_found', status: 404 })
		return notFound(`Service '${name}' not found`)
	}

	const status = await nssmStatus(name)
	auditLog({ token: caller.name, action: 'status', service: name, result: 'ok', status: 200 })
	return ok({ service: name, status })
}

// Dry-run by default: only ?live=1 actually restarts. Auth/allowlist and existence
// checks run before the live-vs-dry branch so a dry-run response reflects the same
// checks a live call would make.
export async function agentRestartHandler(caller: AgentToken, name: string, req: Request): Promise<Response> {
	const url = new URL(req.url)
	const live = url.searchParams.get('live') === '1'

	if (!SERVICE_NAME_RE.test(name) || !isAllowed(caller, name)) {
		auditLog({ token: caller.name, action: 'restart', service: name, live, result: 'forbidden', status: 403 })
		return forbidden(`Not authorized to restart service '${name}'`)
	}

	const nssmNames = await nssmList()
	if (!nssmNames.some(n => n.toLowerCase() === name.toLowerCase())) {
		auditLog({ token: caller.name, action: 'restart', service: name, live, result: 'not_found', status: 404 })
		return notFound(`Service '${name}' not found`)
	}

	if (!live) {
		const status = await nssmStatus(name)
		auditLog({ token: caller.name, action: 'restart', service: name, live, result: 'dry_run', status: 200 })
		return ok({ action: 'restart', service: name, live: false, wouldRestart: true, authorized: true, exists: true, status })
	}

	const result = await nssmRestart(name)
	auditLog({ token: caller.name, action: 'restart', service: name, live, result: result.ok ? 'ok' : 'error', status: result.ok ? 200 : 500 })
	if (!result.ok) return Response.json({ error: 'Restart failed', output: result.output }, { status: 500 })
	return ok({ action: 'restart', service: name, live: true, ok: true, output: result.output })
}
