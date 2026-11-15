// Ad-hoc smoke test for self-service access requests: the agent_access_requests lifecycle
// (denylist and already-granted checks before any row is ever inserted, idempotent re-request
// of a pending row, a new row kept on re-request after denial), the requestAccessHint field on
// a plain scope-miss 403 (and its absence on a denylist 403), addServiceScope's token-file write
// taking effect with no restart and no caching layer to clear, the dashboard approve/deny routes
// (permission gate, defense-in-depth denylist re-check, surface 'dashboard' audit tag through the
// production router), and the request_access MCP tool as a thin wrapper over the same path.
// Run via `bun run scripts/smoke-access-requests.ts`.
export {} // dynamic imports below do not mark this as a module on their own

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Route modules pull in the DB client; keep it off the working tree
const smokeDir = mkdtempSync(join(tmpdir(), 'warden-smoke-access-requests-'))
process.env.DB_PATH = join(smokeDir, 'warden.db')
process.env.COOKIE_SECRET = '0123456789abcdef0123456789abcdef'
process.env.AUTH_PASSWORD_HASH = await Bun.password.hash('smoke-test-password')
process.env.AGENT_TOKENS_PATH = join(smokeDir, 'agent-tokens.json')
process.env.AGENT_AUDIT_LOG_PATH = join(smokeDir, 'agent-audit.log')

const { router } = await import('../src/router')
const agentTokens = await import('../src/auth/agentTokens')
const agentApi = await import('../src/routes/agentApi')
const services = await import('../src/routes/services')
const mcpTools = await import('../src/mcp/tools')
const db = await import('../src/db/client')
const { signSession } = await import('../src/auth/cookies')

const TOKEN = 'wat_smoke_access_requests'
const TOKEN_NAME = 'access-agent'
// A second, independent token: its presence throughout the run lets the cross-token
// isolation check below exercise the real token file (two entries), not a mock of one.
const TOKEN2 = 'wat_smoke_access_requests_2'
const TOKEN_NAME2 = 'access-agent-2'

function writeTokens(serviceList: string[], otherServiceList: string[] = []): void {
	writeFileSync(
		process.env.AGENT_TOKENS_PATH!,
		JSON.stringify({
			tokens: [
				{ name: TOKEN_NAME, token: TOKEN, services: serviceList },
				{ name: TOKEN_NAME2, token: TOKEN2, services: otherServiceList },
			],
		}),
	)
}
writeTokens(['granted-svc'])

// Re-resolves from the token file fresh every call (resolveAgentToken has no caching),
// so callers always see the file's current state.
function caller() {
	const resolved = agentTokens.resolveAgentToken(TOKEN)
	if (!resolved) throw new Error('test setup: token did not resolve')
	return resolved
}

function caller2() {
	const resolved = agentTokens.resolveAgentToken(TOKEN2)
	if (!resolved) throw new Error('test setup: second token did not resolve')
	return resolved
}

const requestReq = (body: Record<string, unknown>) => new Request('http://x/v1/access-requests', { method: 'POST', body: JSON.stringify(body) })
const operatorCtx = (grants: Record<string, boolean>) => ({ accessToken: 't', user: { id: '1', email: 'approver@x', name: 'Approver' }, grants })
const auditLines = () => readFileSync(process.env.AGENT_AUDIT_LOG_PATH!, 'utf8').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)
const lastAudit = () => auditLines().at(-1)!

// --- Denylisted target: rejected, never inserts a row ---
let r = await agentApi.requestAccessHandler(caller(), requestReq({ service: 'tf-core' }))
if (r.status !== 403) throw new Error('denylisted target must be 403, got ' + r.status)
if (db.listAccessRequests().some(row => row.service_name === 'tf-core')) throw new Error('denylisted target must never insert a row')

// --- Already granted: rejected, never inserts a row ---
r = await agentApi.requestAccessHandler(caller(), requestReq({ service: 'granted-svc' }))
if (r.status !== 400) throw new Error('already-granted target must be 400, got ' + r.status)
if (db.listAccessRequests().some(row => row.service_name === 'granted-svc')) throw new Error('already-granted target must never insert a row')

// --- First request: inserts a pending row ---
r = await agentApi.requestAccessHandler(caller(), requestReq({ service: 'pending-svc', reason: 'need it for automation' }))
if (r.status !== 201) throw new Error('first request must be 201, got ' + r.status)
const firstRow = (await r.json()) as { id: string; status: string; reason: string | null }
if (firstRow.status !== 'pending') throw new Error('new request must be pending: ' + JSON.stringify(firstRow))
if (firstRow.reason !== 'need it for automation') throw new Error('reason must round-trip: ' + JSON.stringify(firstRow))

// --- Idempotent re-request of the pending row: same row returned, no duplicate inserted ---
r = await agentApi.requestAccessHandler(caller(), requestReq({ service: 'pending-svc' }))
if (r.status !== 201) throw new Error('idempotent re-request must still be 201, got ' + r.status)
const secondRow = (await r.json()) as { id: string }
if (secondRow.id !== firstRow.id) throw new Error('re-requesting a pending row must return the same row, not a duplicate')
const pendingCount = db.listAccessRequestsForToken(TOKEN_NAME).filter(row => row.service_name === 'pending-svc').length
if (pendingCount !== 1) throw new Error('exactly one row expected for a repeated pending request, got ' + pendingCount)

// --- GET /v1/access-requests: caller's own requests only ---
r = await agentApi.listAccessRequestsHandler(caller())
if (r.status !== 200) throw new Error('list must be 200, got ' + r.status)
const listed = ((await r.json()) as { requests: Array<{ service_name: string }> }).requests
if (!listed.some(row => row.service_name === 'pending-svc')) throw new Error('list must include the pending request: ' + JSON.stringify(listed))

// --- Cross-token isolation: GET /v1/access-requests never returns another token's rows ---
// This is the brief's own highest-risk invariant for this route ("never another token's"), so
// it is exercised with a second, independently provisioned token, not a filter on one token's
// own rows.
r = await agentApi.requestAccessHandler(caller2(), requestReq({ service: 'second-token-svc', reason: 'belongs to access-agent-2' }))
if (r.status !== 201) throw new Error('second token request must succeed, got ' + r.status)
const secondTokenRow = (await r.json()) as { id: string; token_name: string }
if (secondTokenRow.token_name !== TOKEN_NAME2) throw new Error('second token row must be attributed to the second token: ' + JSON.stringify(secondTokenRow))

r = await agentApi.listAccessRequestsHandler(caller())
const firstTokenList = ((await r.json()) as { requests: Array<{ id: string; token_name: string; service_name: string }> }).requests
if (firstTokenList.some(row => row.token_name !== TOKEN_NAME)) {
	throw new Error("GET /v1/access-requests for '" + TOKEN_NAME + "' must never include another token's row: " + JSON.stringify(firstTokenList))
}
if (firstTokenList.some(row => row.id === secondTokenRow.id || row.service_name === 'second-token-svc')) {
	throw new Error("the first token must never see the second token's request: " + JSON.stringify(firstTokenList))
}

r = await agentApi.listAccessRequestsHandler(caller2())
const secondTokenList = ((await r.json()) as { requests: Array<{ id: string; token_name: string; service_name: string }> }).requests
if (secondTokenList.some(row => row.token_name !== TOKEN_NAME2)) {
	throw new Error("GET /v1/access-requests for '" + TOKEN_NAME2 + "' must never include another token's row: " + JSON.stringify(secondTokenList))
}
if (secondTokenList.some(row => row.id === firstRow.id || row.service_name === 'pending-svc')) {
	throw new Error("the second token must never see the first token's request: " + JSON.stringify(secondTokenList))
}
if (!secondTokenList.some(row => row.id === secondTokenRow.id)) {
	throw new Error("the second token's own list must include its own request: " + JSON.stringify(secondTokenList))
}

// --- Deny the pending row, then re-request after denial: a new row, history kept ---
let decideResp = await services.denyAccessRequestHandler(operatorCtx({ 'services.install': true }), firstRow.id)
if (decideResp.status !== 200) throw new Error('deny must succeed, got ' + decideResp.status)
const denied = (await decideResp.json()) as { status: string; decided_by: string }
if (denied.status !== 'denied') throw new Error('row must be denied: ' + JSON.stringify(denied))
if (denied.decided_by !== 'approver@x') throw new Error('decided_by must be the operator identity: ' + JSON.stringify(denied))

r = await agentApi.requestAccessHandler(caller(), requestReq({ service: 'pending-svc' }))
if (r.status !== 201) throw new Error('re-request after denial must succeed, got ' + r.status)
const afterDenial = (await r.json()) as { id: string; status: string }
if (afterDenial.id === firstRow.id) throw new Error('re-request after denial must insert a new row, not reuse the denied one')
if (afterDenial.status !== 'pending') throw new Error('re-request after denial must be pending: ' + JSON.stringify(afterDenial))
const history = db.listAccessRequestsForToken(TOKEN_NAME).filter(row => row.service_name === 'pending-svc')
if (history.length !== 2) throw new Error('history must be kept: expected 2 rows for pending-svc, got ' + history.length)

// --- requestAccessHint: present on a plain scope miss, absent on a denylist hit ---
r = await agentApi.agentStatusHandler(caller(), 'pending-svc')
if (r.status !== 403) throw new Error('status on an un-granted service must be 403, got ' + r.status)
const scopeMiss = (await r.json()) as { requestAccessHint?: string }
if (scopeMiss.requestAccessHint !== "POST /v1/access-requests with { service: 'pending-svc' }") {
	throw new Error('requestAccessHint missing or wrong on a plain scope miss: ' + JSON.stringify(scopeMiss))
}
r = await agentApi.agentStatusHandler(caller(), 'tf-core')
if (r.status !== 403) throw new Error('status on a denylisted name must be 403, got ' + r.status)
const denylistMiss = (await r.json()) as { requestAccessHint?: string }
if (denylistMiss.requestAccessHint !== undefined) throw new Error('requestAccessHint must be absent on a denylist hit: ' + JSON.stringify(denylistMiss))

r = await agentApi.agentRestartHandler(caller(), 'pending-svc', new Request('http://x/v1/services/pending-svc/restart', { method: 'POST' }))
if (r.status !== 403) throw new Error('restart on an un-granted service must be 403, got ' + r.status)
const restartScopeMiss = (await r.json()) as { requestAccessHint?: string }
if (!restartScopeMiss.requestAccessHint) throw new Error('requestAccessHint missing on restart scope miss: ' + JSON.stringify(restartScopeMiss))
r = await agentApi.agentRestartHandler(caller(), 'tf-core', new Request('http://x/v1/services/tf-core/restart', { method: 'POST' }))
const restartDenylistMiss = (await r.json()) as { requestAccessHint?: string }
if (restartDenylistMiss.requestAccessHint !== undefined) throw new Error('requestAccessHint must be absent on a denylisted restart: ' + JSON.stringify(restartDenylistMiss))

// --- Approve: addServiceScope writes the grant to the token file, and the very next call in
// this same process sees it — no restart, no caching layer anywhere in the path ---
let approveResp = await services.approveAccessRequestHandler(operatorCtx({ 'services.install': true }), afterDenial.id)
if (approveResp.status !== 200) throw new Error('approve must succeed, got ' + approveResp.status)
const approved = (await approveResp.json()) as { status: string; decided_by: string }
if (approved.status !== 'approved') throw new Error('row must be approved: ' + JSON.stringify(approved))

const fileAfterApprove = JSON.parse(readFileSync(process.env.AGENT_TOKENS_PATH!, 'utf8')) as { tokens: Array<{ name: string; services: string[] }> }
const entryAfterApprove = fileAfterApprove.tokens.find(t => t.name === TOKEN_NAME)
if (!entryAfterApprove?.services.some(s => s.toLowerCase() === 'pending-svc')) {
	throw new Error('addServiceScope must write the grant to the token file: ' + JSON.stringify(entryAfterApprove))
}

const freshCaller = caller()
if (!agentApi.isAllowed(freshCaller, 'pending-svc')) throw new Error('isAllowed must see the newly granted scope without a restart')
r = await agentApi.agentStatusHandler(freshCaller, 'pending-svc')
if (r.status === 403) throw new Error('status must no longer be 403 for the newly granted service: ' + JSON.stringify(await r.json()))

// --- Approving an already-decided request is rejected, not silently repeated ---
let reapprove = await services.approveAccessRequestHandler(operatorCtx({ 'services.install': true }), afterDenial.id)
if (reapprove.status !== 400) throw new Error('re-deciding an already-decided request must be rejected, got ' + reapprove.status)

// --- Defense in depth: approve must refuse a denylisted target even if a row somehow reached
// pending (bypassing the up-front check normally done by requestAccessHandler) ---
const sneaked = db.createAccessRequest(TOKEN_NAME, 'tf-sneaky', 'bypass attempt')
let sneakyApprove = await services.approveAccessRequestHandler(operatorCtx({ 'services.install': true }), sneaked.id)
if (sneakyApprove.status !== 400) throw new Error('approve must refuse a denylisted target even if it reached pending, got ' + sneakyApprove.status)
const sneakyRow = db.listAccessRequests().find(row => row.id === sneaked.id)
if (sneakyRow?.status !== 'pending') throw new Error('a refused denylisted approval must not mark the row decided: ' + JSON.stringify(sneakyRow))
const fileAfterSneaky = JSON.parse(readFileSync(process.env.AGENT_TOKENS_PATH!, 'utf8')) as { tokens: Array<{ name: string; services: string[] }> }
if (fileAfterSneaky.tokens.find(t => t.name === TOKEN_NAME)?.services.some(s => s.toLowerCase() === 'tf-sneaky')) {
	throw new Error('approve must never write a denylisted name into the token file')
}

// --- Dashboard permission gating: services.install required for approve and deny alike ---
let unauthorizedApprove = await services.approveAccessRequestHandler(operatorCtx({}), sneaked.id)
if (unauthorizedApprove.status !== 403) throw new Error('approve without services.install must be 403, got ' + unauthorizedApprove.status)
let unauthorizedDeny = await services.denyAccessRequestHandler(operatorCtx({}), sneaked.id)
if (unauthorizedDeny.status !== 403) throw new Error('deny without services.install must be 403, got ' + unauthorizedDeny.status)

// --- End to end through the production router: session-cookie auth, surface tagged 'dashboard' ---
const sid = db.createSession({
	accessToken: 'op-token',
	user: { id: '2', email: 'router-approver@x', name: 'Router Approver' },
	grants: { 'services.install': true, 'services.view': true },
})
const cookie = `warden_session=${signSession(sid)}`

r = await agentApi.requestAccessHandler(caller(), requestReq({ service: 'router-approve-svc' }))
const routerApproveRow = (await r.json()) as { id: string }
const approveViaRouter = await router(
	new Request('http://x/access-requests/' + routerApproveRow.id + '/approve', { method: 'POST', headers: { Cookie: cookie, Accept: 'application/json' } }),
)
if (approveViaRouter.status !== 200) throw new Error('router approve must succeed, got ' + approveViaRouter.status)
if (lastAudit().surface !== 'dashboard') throw new Error("router approve must be audited with surface 'dashboard', got " + JSON.stringify(lastAudit()))
if (lastAudit().action !== 'access_request' || lastAudit().result !== 'approved') throw new Error('unexpected audit entry for router approve: ' + JSON.stringify(lastAudit()))

r = await agentApi.requestAccessHandler(caller(), requestReq({ service: 'router-deny-svc' }))
const routerDenyRow = (await r.json()) as { id: string }
const denyViaRouter = await router(
	new Request('http://x/access-requests/' + routerDenyRow.id + '/deny', { method: 'POST', headers: { Cookie: cookie, Accept: 'application/json' } }),
)
if (denyViaRouter.status !== 200) throw new Error('router deny must succeed, got ' + denyViaRouter.status)
if (lastAudit().surface !== 'dashboard' || lastAudit().result !== 'denied') throw new Error("router deny must be audited with surface 'dashboard', got " + JSON.stringify(lastAudit()))

// A request for a service the router-deny path never granted must still be refused afterward
r = await agentApi.agentStatusHandler(caller(), 'router-deny-svc')
if (r.status !== 403) throw new Error('a denied request must never grant access: status should still be 403, got ' + r.status)

const missing = await router(new Request('http://x/access-requests/does-not-exist/approve', { method: 'POST', headers: { Cookie: cookie } }))
if (missing.status !== 404) throw new Error('approve on an unknown id must be 404, got ' + missing.status)

// --- request_access MCP tool: thin wrapper over the same /v1 path, not a reimplementation ---
const tool = mcpTools.findTool('request_access')
if (!tool) throw new Error('request_access tool must be registered')
const mcpResult = await tool.call(caller(), { service: 'mcp-access-svc', reason: 'via mcp' })
if (mcpResult.status !== 201) throw new Error('request_access tool must insert via the same path, got ' + mcpResult.status)
const mcpBody = (await mcpResult.json()) as { status: string; service_name: string }
if (mcpBody.service_name !== 'mcp-access-svc' || mcpBody.status !== 'pending') throw new Error('unexpected request_access result: ' + JSON.stringify(mcpBody))

console.log('smoke-access-requests ok')
process.exit(0)
