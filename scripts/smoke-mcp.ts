// Ad-hoc smoke test for the /mcp JSON-RPC surface, driven through the production router:
// envelope (initialize, ping, notifications, tools/list, tools/call, malformed input), bearer
// auth identical to /v1, per-token scoping, restart_service dry-run by default, the hardcoded
// agentic-group fence on configure/install (not bypassable via tool arguments), and audit lines.
// NSSM is only ever read (list/status); no install and no live restart is performed.
// Run via `bun run scripts/smoke-mcp.ts`.
export {} // dynamic imports below do not mark this as a module on their own

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pkg from '../package.json'

// Route modules pull in the DB client; keep it off the working tree
const smokeDir = mkdtempSync(join(tmpdir(), 'warden-smoke-mcp-'))
process.env.DB_PATH = join(smokeDir, 'warden.db')
process.env.COOKIE_SECRET = '0123456789abcdef0123456789abcdef'
process.env.AUTH_PASSWORD_HASH = await Bun.password.hash('smoke-test-password')
process.env.AGENT_TOKENS_PATH = join(smokeDir, 'agent-tokens.json')
process.env.AGENT_AUDIT_LOG_PATH = join(smokeDir, 'agent-audit.log')

const { router } = await import('../src/router')
const { isDenylisted } = await import('../src/auth/agentTokens')
const { nssmList } = await import('../src/nssm/client')
const { negotiateProtocolVersion, RPC_ERROR, SUPPORTED_PROTOCOL_VERSIONS } = await import('../src/mcp/server')
const { restartUrl } = await import('../src/mcp/tools')
const db = await import('../src/db/client')

const eq = (a: unknown, b: unknown, msg: string) => {
	if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`)
}
const ok = (cond: boolean, msg: string) => {
	if (!cond) throw new Error(msg)
}

const READER = 'wat_smoke_mcp_reader'
const INSTALLER = 'wat_smoke_mcp_installer'
const writeTokens = (readerServices: string[]) =>
	writeFileSync(process.env.AGENT_TOKENS_PATH!, JSON.stringify({
		tokens: [
			{ name: 'mcp-reader', token: READER, services: readerServices },
			{ name: 'mcp-installer', token: INSTALLER, services: ['mcp-agentic-svc'], canInstall: true },
		],
	}))
writeTokens(['mcp-svc', 'tf-core', 'mcp-agentic-svc'])

const post = (token: string | null, body: string, path = '/mcp') =>
	router(new Request('http://x' + path, {
		method: 'POST',
		headers: token ? { authorization: `Bearer ${token}` } : {},
		body,
	}))

let nextId = 1
async function rpc(token: string, method: string, params?: unknown): Promise<Record<string, any>> {
	const r = await post(token, JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }))
	eq(r.status, 200, `${method} HTTP status`)
	return (await r.json()) as Record<string, any>
}
async function callTool(token: string, name: string, args?: Record<string, unknown>): Promise<{ isError: boolean; body: Record<string, any> }> {
	const msg = await rpc(token, 'tools/call', { name, arguments: args })
	ok(msg.result !== undefined, `tools/call ${name} must return a result: ${JSON.stringify(msg)}`)
	const content = msg.result.content as Array<{ type: string; text: string }>
	eq(content.length, 1, `${name} content length`)
	eq(content[0]!.type, 'text', `${name} content type`)
	return { isError: msg.result.isError, body: JSON.parse(content[0]!.text) }
}
const auditLines = () =>
	readFileSync(process.env.AGENT_AUDIT_LOG_PATH!, 'utf8').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)
const lastAudit = () => auditLines().at(-1)!

// --- Auth: rejected exactly as /v1 rejects it ---
for (const token of [null, 'wat_not_a_real_token']) {
	const mcp = await post(token, '{}')
	const v1 = await router(new Request('http://x/v1/services', { headers: token ? { authorization: `Bearer ${token}` } : {} }))
	eq(mcp.status, 401, `/mcp with ${token ? 'invalid' : 'missing'} token`)
	eq([mcp.status, await mcp.json()], [v1.status, await v1.json()], `/mcp and /v1 auth rejection must match (${token ? 'invalid' : 'missing'})`)
}
eq(auditLines().map(l => l.result), ['missing_token', 'missing_token', 'invalid_token', 'invalid_token'], 'auth failures are audited for /mcp and /v1 alike')

// --- Transport: POST only ---
eq((await router(new Request('http://x/mcp'))).status, 405, 'GET /mcp is 405 (no SSE stream)')
eq((await router(new Request('http://x/mcp', { method: 'DELETE' }))).status, 405, 'DELETE /mcp is 405 (no sessions)')

// --- initialize / ping / notifications ---
eq(negotiateProtocolVersion('2025-06-18'), '2025-06-18', 'supported version is echoed')
eq(negotiateProtocolVersion('1999-01-01'), SUPPORTED_PROTOCOL_VERSIONS[0], 'unsupported version falls back to newest')
eq(negotiateProtocolVersion(undefined), SUPPORTED_PROTOCOL_VERSIONS[0], 'missing version falls back to newest')

const init = await rpc(READER, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } })
eq(init.jsonrpc, '2.0', 'initialize jsonrpc')
eq(init.result, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'warden', version: pkg.version } }, 'initialize result')
eq((await rpc(READER, 'ping')).result, {}, 'ping returns an empty result')

const notified = await post(READER, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))
eq([notified.status, await notified.text()], [202, ''], 'notification is accepted with 202 and no body')

// --- tools/list: exactly the five tools, nothing more ---
const listed = await rpc(READER, 'tools/list')
const tools = listed.result.tools as Array<{ name: string; description: string; inputSchema: { type: string } }>
eq(tools.map(t => t.name).sort(), ['configure_service', 'get_service_status', 'install_service', 'list_services', 'restart_service'], 'tool names')
ok(tools.every(t => t.description && t.inputSchema.type === 'object'), 'every tool has a description and an object inputSchema')

// --- Malformed envelopes and params ---
const errorOf = async (body: string) => {
	const r = await post(READER, body)
	return [r.status, ((await r.json()) as { error: { code: number } }).error.code]
}
eq(await errorOf('not json'), [400, RPC_ERROR.parse], 'invalid JSON is a parse error')
eq(await errorOf('[{"jsonrpc":"2.0","id":1,"method":"ping"}]'), [400, RPC_ERROR.invalidRequest], 'batches are refused')
eq(await errorOf('{"jsonrpc":"1.0","id":1,"method":"ping"}'), [400, RPC_ERROR.invalidRequest], 'wrong jsonrpc version is refused')
eq(await errorOf('{"jsonrpc":"2.0","id":{},"method":"ping"}'), [400, RPC_ERROR.invalidRequest], 'object id is refused')
eq((await rpc(READER, 'resources/list')).error.code, RPC_ERROR.methodNotFound, 'unknown method')
eq((await rpc(READER, 'tools/call')).error.code, RPC_ERROR.invalidParams, 'tools/call without params')
eq((await rpc(READER, 'tools/call', { arguments: {} })).error.code, RPC_ERROR.invalidParams, 'tools/call without a tool name')
eq((await rpc(READER, 'tools/call', { name: 'uninstall_service', arguments: {} })).error.code, RPC_ERROR.invalidParams, 'unknown tool (no uninstall capability)')
eq((await rpc(READER, 'tools/call', { name: 'get_service_status', arguments: ['mcp-svc'] })).error.code, RPC_ERROR.invalidParams, 'array arguments')

// --- list_services: buildServices() filtered by the token allowlist and denylist ---
db.upsertService('mcp-svc', { group_name: 'g', managed: true })
db.upsertService('tf-core', { group_name: 'g', managed: true })
db.upsertService('mcp-unlisted-svc', { group_name: 'g', managed: true })
let res = await callTool(READER, 'list_services')
eq(res.isError, false, 'list_services succeeds')
const listedNames = (res.body.services as Array<{ name: string }>).map(s => s.name)
ok(listedNames.includes('mcp-svc'), 'allowlisted service is listed: ' + listedNames)
ok(!listedNames.includes('tf-core'), 'denylisted service is never listed, even when allowlisted')
ok(!listedNames.includes('mcp-unlisted-svc'), 'service outside the allowlist is never listed')
ok(listedNames.every(n => ['mcp-svc', 'tf-core', 'mcp-agentic-svc'].includes(n)), 'only allowlisted names are listed: ' + listedNames)
eq([lastAudit().token, lastAudit().action, lastAudit().result], ['mcp-reader', 'list', 'ok'], 'list_services is audited')

// --- get_service_status: same refusals as /v1, audited ---
res = await callTool(READER, 'get_service_status', { name: 'mcp-unlisted-svc' })
eq([res.isError, res.body.error], [true, "Not authorized for service 'mcp-unlisted-svc'"], 'status outside the allowlist')
eq([lastAudit().action, lastAudit().service, lastAudit().result], ['status', 'mcp-unlisted-svc', 'forbidden'], 'status refusal is audited')
res = await callTool(READER, 'get_service_status', { name: 'tf-core' })
eq(res.isError, true, 'status on a denylisted name is refused')
res = await callTool(READER, 'get_service_status', { name: 42 })
eq([res.isError, lastAudit().result], [true, 'forbidden'], 'non-string name is refused by the shared handler and audited')
res = await callTool(READER, 'get_service_status', { name: 'mcp-svc' })
eq([res.isError, res.body.error], [true, "Service 'mcp-svc' not found"], 'allowlisted but not an NSSM service')

// --- restart_service: dry-run unless live is exactly true ---
eq(restartUrl('svc', undefined).endsWith('/restart'), true, 'omitted live is dry-run')
eq(restartUrl('svc', false).endsWith('/restart'), true, 'live false is dry-run')
eq(restartUrl('svc', 'true').endsWith('/restart'), true, 'string "true" is dry-run')
eq(restartUrl('svc', 1).endsWith('/restart'), true, 'numeric 1 is dry-run')
eq(restartUrl('svc', true).endsWith('/restart?live=1'), true, 'only boolean true goes live')

res = await callTool(READER, 'restart_service', { name: 'mcp-unlisted-svc' })
eq([res.isError, lastAudit().action, lastAudit().live, lastAudit().result], [true, 'restart', false, 'forbidden'], 'restart outside the allowlist, dry-run')
res = await callTool(READER, 'restart_service', { name: 'mcp-unlisted-svc', live: true })
eq([res.isError, lastAudit().live, lastAudit().result], [true, true, 'forbidden'], 'live restart outside the allowlist is still refused')
res = await callTool(READER, 'restart_service', { name: 'mcp-svc', live: 'true' })
eq([res.isError, lastAudit().live, lastAudit().result], [true, false, 'not_found'], 'string live stays dry-run end to end')

// Real dry-run against an existing NSSM service on this machine (read-only: list + status)
const realSvc = (await nssmList()).find(n => !isDenylisted(n))
if (realSvc) {
	writeTokens(['mcp-svc', 'tf-core', 'mcp-agentic-svc', realSvc])
	res = await callTool(READER, 'restart_service', { name: realSvc })
	eq([res.isError, res.body.live, res.body.wouldRestart, res.body.authorized, res.body.exists], [false, false, true, true, true], 'restart without live is a dry run')
	eq([lastAudit().live, lastAudit().result], [false, 'dry_run'], 'dry run is audited as dry_run')
	writeTokens(['mcp-svc', 'tf-core', 'mcp-agentic-svc'])
} else {
	console.log('smoke-mcp: no non-denylisted NSSM service on this machine, existing-service dry-run check not exercised')
}

// --- configure_service / install_service: canInstall + allowlist gates, as /v1 ---
res = await callTool(READER, 'configure_service', { name: 'mcp-agentic-svc', display: 'x' })
eq([res.isError, lastAudit().action, lastAudit().result], [true, 'configure', 'forbidden'], 'configure without canInstall')
res = await callTool(READER, 'install_service', { name: 'mcp-agentic-svc', program: process.execPath })
eq([res.isError, lastAudit().action, lastAudit().result], [true, 'install', 'forbidden'], 'install without canInstall')
res = await callTool(INSTALLER, 'install_service', { name: 'mcp-unlisted-svc', program: process.execPath })
eq([res.isError, lastAudit().result], [true, 'forbidden'], 'install outside the allowlist despite canInstall')
res = await callTool(INSTALLER, 'configure_service', { name: 'mcp-svc', display: 'x' })
eq([res.isError, lastAudit().result], [true, 'forbidden'], 'configure outside the allowlist despite canInstall')

// Authorized install reaches the shared performInstall validation (422), never NSSM
res = await callTool(INSTALLER, 'install_service', { name: 'mcp-agentic-svc', program: '/no/such/program-zz', group_name: 'escape-group' })
eq([res.isError, lastAudit().group_name, lastAudit().status], [true, 'agentic', 422], 'authorized install reaches validation, audited under the agentic group')

// --- The agentic-group fence cannot be bypassed through tool arguments ---
// Service exists outside the group; the token is fully authorized for it. Arguments claiming the
// group, or naming the internal option keys, must not open the fence.
db.upsertService('mcp-agentic-svc', { group_name: 'other-group', managed: true })
for (const bypass of [
	{ group_name: 'agentic' },
	{ requireGroupName: 'other-group', forcedGroupName: 'other-group' },
	{ group: 'agentic', canInstall: true },
]) {
	res = await callTool(INSTALLER, 'configure_service', { name: 'mcp-agentic-svc', display: 'hijacked', ...bypass })
	eq([res.isError, res.body.error], [true, "Service 'mcp-agentic-svc' is not in the 'agentic' group"], 'fence holds against ' + JSON.stringify(bypass))
	eq([lastAudit().token, lastAudit().group_name, lastAudit().status], ['mcp-installer', 'agentic', 403], 'fence refusal is audited')
}
const untouched = db.getService('mcp-agentic-svc')
eq([untouched?.group_name, untouched?.display ?? null], ['other-group', null], 'refused configures must not change the row')

// Inside the group: configure applies, but group_name stays pinned to agentic
db.upsertService('mcp-agentic-svc', { group_name: 'agentic' })
res = await callTool(INSTALLER, 'configure_service', { name: 'mcp-agentic-svc', display: 'new', group_name: 'escape-group' })
eq([res.isError, res.body.group_name, res.body.display], [false, 'agentic', 'new'], 'configure inside the group applies other fields, pins the group')
eq([lastAudit().action, lastAudit().result, lastAudit().status], ['configure', 'ok', 200], 'successful configure is audited')
eq(db.getService('mcp-agentic-svc')?.group_name, 'agentic', 'row group_name stays agentic')

console.log('smoke-mcp ok')
process.exit(0)
