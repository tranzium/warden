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
process.env.LOGS_DIR = './logs'

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

// Uninstall: stop-first ordering, force fallback, refuse-while-live, artifact cleanup
const un = await import('../src/nssm/uninstall')
const { resolve } = await import('node:path')
const fast = { gracefulMs: 20, forceMs: 20, pollMs: 5 }
function fakeOps(opts: { stopsOnStop?: boolean; stopsOnKill?: boolean; logs?: boolean; removeOk?: boolean }) {
	const calls: string[] = []
	let state: 'Running' | 'Stopped' = 'Running'
	const logRoot = resolve('./logs/svc')
	const ops: import('../src/nssm/uninstall').UninstallOps = {
		status: async () => state,
		stop: async () => {
			calls.push('stop')
			if (opts.stopsOnStop) state = 'Stopped'
			return { ok: true, output: '' }
		},
		pid: async () => {
			calls.push('pid')
			return 4242
		},
		kill: async () => {
			calls.push('kill')
			if (opts.stopsOnKill) state = 'Stopped'
			return true
		},
		remove: async () => {
			calls.push(`remove@${state}`)
			return opts.removeOk === false ? { ok: false, output: 'nope' } : { ok: true, output: '' }
		},
		get: async (_n, p) => (opts.logs === false ? '/elsewhere/' + p + '.log' : `${logRoot}/${p}.log`),
		removeDir: p => {
			calls.push('rmdir')
			void p
		},
		sleep: ms => new Promise(r => setTimeout(r, Math.min(ms, 2))),
	}
	return { ops, calls }
}

let f = fakeOps({ stopsOnStop: true })
let ur = await un.uninstallService('svc', f.ops, fast)
if (!ur.ok || ur.stopped !== 'graceful') throw new Error('running service should be stopped gracefully')
if (f.calls.join() !== 'stop,remove@Stopped,rmdir') throw new Error('stop must precede remove, then cleanup: ' + f.calls.join())
if (!ur.cleaned.length) throw new Error('owned log dir should be reported cleaned')

f = fakeOps({ stopsOnKill: true })
ur = await un.uninstallService('svc', f.ops, fast)
if (!ur.ok || ur.stopped !== 'forced') throw new Error('stuck service should be force-killed')
if (f.calls.join() !== 'stop,pid,kill,remove@Stopped,rmdir') throw new Error('unexpected force sequence: ' + f.calls.join())

f = fakeOps({})
ur = await un.uninstallService('svc', f.ops, fast)
if (ur.ok) throw new Error('uninstall must be refused while the process is still live')
if (f.calls.some(c => c.startsWith('remove') || c === 'rmdir')) throw new Error('no destructive step may run while live: ' + f.calls.join())

f = fakeOps({ stopsOnStop: true, logs: false })
ur = await un.uninstallService('svc', f.ops, fast)
if (!ur.ok || ur.cleaned.length || f.calls.includes('rmdir')) throw new Error('log files outside the default dir must not be deleted')

f = fakeOps({ stopsOnStop: true, removeOk: false })
ur = await un.uninstallService('svc', f.ops, fast)
if (ur.ok || f.calls.includes('rmdir')) throw new Error('failed remove must not clean artifacts')

console.log('smoke ok')
process.exit(0)
