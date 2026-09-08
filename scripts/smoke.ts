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

console.log('smoke ok')
process.exit(0)
