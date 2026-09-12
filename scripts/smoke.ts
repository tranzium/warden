// Ad-hoc smoke test: boots the module graph against a temp DB and exercises
// the session + service-overlay roundtrips. Run via `bun run scripts/smoke.ts`.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export {} // dynamic imports below don't mark this as a module on their own

const smokeDir = mkdtempSync(join(tmpdir(), 'warden-smoke-'))
process.env.DB_PATH = join(smokeDir, 'warden.db')
process.env.COOKIE_SECRET = '0123456789abcdef0123456789abcdef'
process.env.AUTH_PASSWORD_HASH = await Bun.password.hash('smoke-test-password')
process.env.AGENT_TOKENS_PATH = join(smokeDir, 'agent-tokens.json')
process.env.AGENT_AUDIT_LOG_PATH = join(smokeDir, 'agent-audit.log')

await import('../src/router')
const db = await import('../src/db/client')

const sid = db.createSession({
	accessToken: 'tok',
	user: { id: '1', email: 'e@x', name: 'n' },
	grants: { 'services.view': true },
})
const s = db.getSession(sid)
if (!s || s.email !== 'e@x') throw new Error('session roundtrip failed')
if (s.stale) throw new Error('fresh session should not be stale')
db.touchSession(sid)
db.refreshSessionGrants(sid, { 'services.view': true, 'services.install': true })
const s2 = db.getSession(sid)
if (!s2 || !(JSON.parse(s2.grants) as Record<string, boolean>)['services.install']) throw new Error('grant refresh failed')
db.deleteSession(sid)
if (db.getSession(sid)) throw new Error('session delete failed')

const row = db.upsertService('demo', { group_name: 'G', hidden: true })
if (!row.hidden || row.group_name !== 'G') throw new Error('upsert insert failed')
const row2 = db.upsertService('demo', { hidden: false })
if (row2.hidden || row2.group_name !== 'G') throw new Error('upsert update failed')
db.unregisterService('demo')

// Agent-restart API: token resolution + hardcoded denylist
await Bun.write(
	process.env.AGENT_TOKENS_PATH!,
	JSON.stringify({ tokens: [{ name: 'test-agent', token: 'smoke-token-abc', services: ['demo-svc'] }] }),
)
const agentTokens = await import('../src/auth/agentTokens')
const resolved = agentTokens.resolveAgentToken('smoke-token-abc')
if (!resolved || resolved.name !== 'test-agent') throw new Error('agent token resolution failed')
if (agentTokens.resolveAgentToken('wrong-token')) throw new Error('agent token should not resolve for a wrong token')
if (!agentTokens.isDenylisted('tf-agent')) throw new Error('tf-agent should be denylisted')
if (!agentTokens.isDenylisted('warden')) throw new Error('warden (self) should be denylisted')
if (agentTokens.isDenylisted('demo-svc')) throw new Error('demo-svc should not be denylisted')

// Orbit introspect failure-mode mapping: 401 / 422 / 200-authenticated:false / unreachable
// must map to distinct, non-secret-leaking failureReasons and operator messages.
const orbit = await import('../src/auth/orbit')
const originalFetch = globalThis.fetch
function mockFetchOnce(status: number, body: string): void {
	globalThis.fetch = (async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(body, { status })) as typeof fetch
}

mockFetchOnce(401, '')
let ir = await orbit.introspect('dummy')
if (ir.failureReason !== 'rejected-api-key') throw new Error('expected rejected-api-key for HTTP 401')
if (!orbit.describeIntrospectFailure(ir).includes('API key')) throw new Error('401 message should mention the API key')

mockFetchOnce(422, 'jwt path not configured')
ir = await orbit.introspect('dummy')
if (ir.failureReason !== 'jwt-unconfigured') throw new Error('expected jwt-unconfigured for HTTP 422')
if (!orbit.describeIntrospectFailure(ir).includes('JWT verification')) throw new Error('422 message should mention JWT verification')

mockFetchOnce(200, JSON.stringify({ authenticated: false, denied_reason: 'issuer_mismatch' }))
ir = await orbit.introspect('dummy')
if (ir.failureReason !== 'token-rejected') throw new Error('expected token-rejected for HTTP 200 authenticated:false')
if (!orbit.describeIntrospectFailure(ir).includes('issuer_mismatch')) throw new Error('200 message should surface denied_reason')

globalThis.fetch = (async (_url: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
	throw new Error('network down')
}) as typeof fetch
ir = await orbit.introspect('dummy')
if (ir.failureReason !== 'unreachable') throw new Error('expected unreachable when fetch throws')

mockFetchOnce(500, 'internal error')
ir = await orbit.introspect('dummy')
if (ir.failureReason !== 'error') throw new Error('expected error for HTTP 500')
if (!orbit.describeIntrospectFailure(ir).includes('500')) throw new Error('non-2xx message should include the status code, not collapse to a generic message')

mockFetchOnce(200, JSON.stringify({ authenticated: true, user: { id: '1', email: 'e@x', name: 'n' } }))
ir = await orbit.introspect('dummy')
if (!ir.authenticated || ir.failureReason) throw new Error('success path must not be tagged with a failureReason')

globalThis.fetch = originalFetch

console.log('smoke ok')
process.exit(0)
