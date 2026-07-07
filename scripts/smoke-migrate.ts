// Verifies the guarded ALTER TABLE picks up old databases created before the
// `hidden` column existed. Run via `bun run scripts/smoke-migrate.ts`.
import { Database } from 'bun:sqlite'
import { mkdirSync, rmSync } from 'node:fs'

rmSync('./data-test', { recursive: true, force: true })
mkdirSync('./data-test', { recursive: true })
const old = new Database('./data-test/warden.db', { create: true })
old.exec(`CREATE TABLE services (
	id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, display TEXT,
	description TEXT, group_name TEXT, managed INTEGER DEFAULT 1,
	created_at TEXT DEFAULT (datetime('now'))
)`)
old.exec("INSERT INTO services (id, name, group_name) VALUES ('a', 'legacy', 'Core')")
old.close()

process.env.DB_PATH = './data-test/warden.db'
process.env.COOKIE_SECRET = '0123456789abcdef0123456789abcdef'
process.env.ORBIT_INTROSPECT_URL = 'http://x'
process.env.ORBIT_API_KEY = 'x'
process.env.ORBIT_TENANT_ID = 'x'
process.env.OAUTH_CLIENT_ID = 'x'
process.env.OAUTH_REDIRECT_URI = 'http://x/callback'
process.env.OAUTH_AUTHORIZE_URL = 'http://x/a'
process.env.OAUTH_TOKEN_URL = 'http://x/t'

const db = await import('../src/db/client')
const row = db.getService('legacy')
if (!row) throw new Error('legacy row lost')
if (row.hidden !== 0) throw new Error('hidden column not defaulted to 0')
const updated = db.updateService('legacy', { hidden: true })
if (!updated || updated.hidden !== 1) throw new Error('hidden update failed')
const sid = db.createSession({ accessToken: 't', user: { id: '1', email: 'e', name: 'n' }, grants: {} })
if (!db.getSession(sid)) throw new Error('sessions table missing on migrated db')

console.log('migration smoke ok')
process.exit(0)
