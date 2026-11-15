import { resolveAgentToken, isDenylisted, isAllowedToInstall, type AgentToken } from '../auth/agentTokens'
import { auditLog } from '../auth/agentAudit'
import { createAccessRequest, listAccessRequestsForToken } from '../db/client'
import { nssmList, nssmStatus, nssmRestart } from '../nssm/client'
import { ok, created, badRequest, forbidden, notFound, unauthorized, unprocessable } from '../shared/http'
import { performInstall, performUpdate } from './services'

// Install/configure via this API are fenced to this one hardcoded group, regardless of
// what a token's config or the request body ask for — never trusted from either.
const AGENTIC_GROUP = 'agentic'

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

export function isAllowed(caller: AgentToken, name: string): boolean {
	if (isDenylisted(name)) return false
	return caller.services.some(s => s.toLowerCase() === name.toLowerCase())
}

// A 403 earns a requestAccessHint only when there is actually something to request: a
// syntactically valid, non-denylisted name the caller simply has not been granted. A malformed
// name or a denylisted one gets a plain 403 — the hint would either be meaningless or, worse,
// suggest a path around the hardcoded fence.
function forbiddenWithHint(message: string, name: string): Response {
	if (!SERVICE_NAME_RE.test(name) || isDenylisted(name)) return forbidden(message)
	return Response.json({ error: message, requestAccessHint: `POST /v1/access-requests with { service: '${name}' }` }, { status: 403 })
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
		return forbiddenWithHint(`Not authorized for service '${name}'`, name)
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
		return forbiddenWithHint(`Not authorized to restart service '${name}'`, name)
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

// name comes from the request body (installs have no route param yet); cloned so
// performInstall can still read the body itself for the full install payload.
export async function agentInstallHandler(caller: AgentToken, req: Request): Promise<Response> {
	let body: Record<string, unknown>
	try {
		body = (await req.clone().json()) as Record<string, unknown>
	} catch {
		body = {}
	}
	const name = typeof body.name === 'string' ? body.name.trim() : ''

	if (!SERVICE_NAME_RE.test(name) || !isAllowedToInstall(caller, name)) {
		auditLog({ token: caller.name, action: 'install', service: name || null, group_name: AGENTIC_GROUP, result: 'forbidden', status: 403 })
		return forbidden(`Not authorized to install service '${name}'`)
	}

	const response = await performInstall(req, { forcedGroupName: AGENTIC_GROUP })
	auditLog({ token: caller.name, action: 'install', service: name, group_name: AGENTIC_GROUP, result: response.ok ? 'ok' : 'error', status: response.status })
	return response
}

export async function agentConfigureHandler(caller: AgentToken, name: string, req: Request): Promise<Response> {
	if (!SERVICE_NAME_RE.test(name) || !isAllowedToInstall(caller, name)) {
		auditLog({ token: caller.name, action: 'configure', service: name, group_name: AGENTIC_GROUP, result: 'forbidden', status: 403 })
		return forbidden(`Not authorized to configure service '${name}'`)
	}

	const response = await performUpdate(name, req, { requireGroupName: AGENTIC_GROUP, agentScoped: true })
	auditLog({ token: caller.name, action: 'configure', service: name, group_name: AGENTIC_GROUP, result: response.ok ? 'ok' : 'error', status: response.status })
	return response
}

// Self-service scope requests: the denylist and already-granted checks run here, before
// createAccessRequest is ever called, so a denylisted or already-granted target never reaches
// a row insert — createAccessRequest itself only owns the idempotent-pending-row rule.
export async function requestAccessHandler(caller: AgentToken, req: Request): Promise<Response> {
	let body: Record<string, unknown>
	try {
		body = (await req.json()) as Record<string, unknown>
	} catch {
		return badRequest('Invalid JSON body')
	}

	const name = typeof body.service === 'string' ? body.service.trim() : ''
	const reason = typeof body.reason === 'string' ? body.reason : undefined

	if (!SERVICE_NAME_RE.test(name)) {
		auditLog({ token: caller.name, action: 'access_request', service: name || null, result: 'invalid', status: 422 })
		return unprocessable('service is required and may only contain letters, digits, dot, underscore and hyphen')
	}

	if (isDenylisted(name)) {
		auditLog({ token: caller.name, action: 'access_request', service: name, result: 'denylisted', status: 403 })
		return forbidden(`Service '${name}' can never be requested`)
	}

	if (caller.services.some(s => s.toLowerCase() === name.toLowerCase())) {
		auditLog({ token: caller.name, action: 'access_request', service: name, result: 'already_granted', status: 400 })
		return badRequest(`Already granted access to '${name}'`)
	}

	const row = createAccessRequest(caller.name, name, reason)
	auditLog({ token: caller.name, action: 'access_request', service: name, result: 'ok', status: 201 })
	return created(row)
}

// A caller's own requests only, scoped by the bearer token itself — no new permission needed.
export async function listAccessRequestsHandler(caller: AgentToken): Promise<Response> {
	const requests = listAccessRequestsForToken(caller.name)
	auditLog({ token: caller.name, action: 'access_request', service: null, result: 'list', status: 200 })
	return ok({ requests })
}
