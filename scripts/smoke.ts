// Ad-hoc smoke test: boots the module graph against a temp DB and exercises
// the session + service-overlay roundtrips. Run via `bun run scripts/smoke.ts`.
process.env.DB_PATH = './data-test/warden.db'
process.env.COOKIE_SECRET = '0123456789abcdef0123456789abcdef'
process.env.ORBIT_INTROSPECT_URL = 'http://x'
process.env.ORBIT_API_KEY = 'x'
process.env.ORBIT_TENANT_ID = 'x'
process.env.OAUTH_CLIENT_ID = 'x'
process.env.OAUTH_REDIRECT_URI = 'http://x/callback'
process.env.OAUTH_AUTHORIZE_URL = 'http://x/a'
process.env.OAUTH_TOKEN_URL = 'http://x/t'

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

console.log('smoke ok')
process.exit(0)
