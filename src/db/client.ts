import { Database } from 'bun:sqlite'
import { readFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { config } from '../shared/config'

const dbDir = dirname(resolve(config.dbPath))
mkdirSync(dbDir, { recursive: true })

const db = new Database(config.dbPath, { create: true })
db.exec('PRAGMA journal_mode = WAL')
db.exec(readFileSync(resolve(import.meta.dir, 'schema.sql'), 'utf8'))

// schema.sql only creates tables; columns added after first release need a guarded ALTER
const serviceCols = db.prepare<{ name: string }, []>('PRAGMA table_info(services)').all()
if (!serviceCols.some(c => c.name === 'hidden')) {
	db.exec('ALTER TABLE services ADD COLUMN hidden INTEGER DEFAULT 0')
}

export interface ServiceRow {
	id: string
	name: string
	display: string | null
	description: string | null
	group_name: string | null
	managed: number
	hidden: number
	created_at: string
}

const listStmt = db.prepare<ServiceRow, []>('SELECT * FROM services ORDER BY group_name, name')
const getStmt = db.prepare<ServiceRow, [string]>('SELECT * FROM services WHERE name = ?')
const insertStmt = db.prepare<void, [string, string, string | null, string | null, string | null, number, number]>(
	'INSERT INTO services (id, name, display, description, group_name, managed, hidden) VALUES (?, ?, ?, ?, ?, ?, ?)',
)
const deleteStmt = db.prepare<void, [string]>('DELETE FROM services WHERE name = ?')
const updateStmt = db.prepare<void, [string | null, string | null, string | null, number, number, string]>(
	'UPDATE services SET display = ?, description = ?, group_name = ?, managed = ?, hidden = ? WHERE name = ?',
)

export function listServices(): ServiceRow[] {
	return listStmt.all()
}

export function getService(name: string): ServiceRow | null {
	return getStmt.get(name) ?? null
}

export function registerService(data: {
	name: string
	display?: string
	description?: string
	group_name?: string
	managed?: boolean
	hidden?: boolean
}): ServiceRow {
	const id = crypto.randomUUID()
	insertStmt.run(
		id,
		data.name,
		data.display ?? null,
		data.description ?? null,
		data.group_name ?? null,
		data.managed !== false ? 1 : 0,
		data.hidden === true ? 1 : 0,
	)
	return getStmt.get(data.name)!
}

export function unregisterService(name: string): boolean {
	const existing = getStmt.get(name)
	if (!existing) return false
	deleteStmt.run(name)
	return true
}

export function updateService(
	name: string,
	data: {
		display?: string | null
		description?: string | null
		group_name?: string | null
		managed?: boolean
		hidden?: boolean
	},
): ServiceRow | null {
	const existing = getStmt.get(name)
	if (!existing) return null

	const display = data.display !== undefined ? data.display : existing.display
	const description = data.description !== undefined ? data.description : existing.description
	const group_name = data.group_name !== undefined ? data.group_name : existing.group_name
	const managed = data.managed !== undefined ? (data.managed ? 1 : 0) : existing.managed
	const hidden = data.hidden !== undefined ? (data.hidden ? 1 : 0) : existing.hidden

	updateStmt.run(display, description, group_name, managed, hidden, name)
	return getStmt.get(name)!
}

// Metadata rows are an overlay on the live NSSM list — editing a service
// that has no row yet creates one.
export function upsertService(
	name: string,
	data: {
		display?: string | null
		description?: string | null
		group_name?: string | null
		managed?: boolean
		hidden?: boolean
	},
): ServiceRow {
	const existing = updateService(name, data)
	if (existing) return existing
	return registerService({
		name,
		display: data.display ?? undefined,
		description: data.description ?? undefined,
		group_name: data.group_name ?? undefined,
		managed: data.managed,
		hidden: data.hidden,
	})
}

// --- Access requests ---

export interface AccessRequestRow {
	id: string
	token_name: string
	service_name: string
	status: string
	reason: string | null
	requested_at: string
	decided_at: string | null
	decided_by: string | null
}

const getAccessRequestStmt = db.prepare<AccessRequestRow, [string]>('SELECT * FROM agent_access_requests WHERE id = ?')
const getPendingAccessRequestStmt = db.prepare<AccessRequestRow, [string, string]>(
	"SELECT * FROM agent_access_requests WHERE token_name = ? AND service_name = ? COLLATE NOCASE AND status = 'pending'",
)
const insertAccessRequestStmt = db.prepare<void, [string, string, string, string | null]>(
	'INSERT INTO agent_access_requests (id, token_name, service_name, reason) VALUES (?, ?, ?, ?)',
)
const listAccessRequestsStmt = db.prepare<AccessRequestRow, []>('SELECT * FROM agent_access_requests ORDER BY requested_at DESC')
const listAccessRequestsByStatusStmt = db.prepare<AccessRequestRow, [string]>(
	'SELECT * FROM agent_access_requests WHERE status = ? ORDER BY requested_at DESC',
)
const listAccessRequestsForTokenStmt = db.prepare<AccessRequestRow, [string]>(
	'SELECT * FROM agent_access_requests WHERE token_name = ? ORDER BY requested_at DESC',
)
const decideAccessRequestStmt = db.prepare<void, [string, string, string]>(
	"UPDATE agent_access_requests SET status = ?, decided_by = ?, decided_at = datetime('now') WHERE id = ?",
)

// Denylist and already-granted checks are the caller's responsibility (routes/agentApi.ts):
// by the time this runs, a row is always safe to have pending or inserted. This function only
// owns the idempotency rule — an existing pending row for the same (token_name, service_name)
// is returned as-is, never duplicated; a prior denied request does not block a new one.
export function createAccessRequest(tokenName: string, serviceName: string, reason?: string): AccessRequestRow {
	const pending = getPendingAccessRequestStmt.get(tokenName, serviceName)
	if (pending) return pending

	const id = crypto.randomUUID()
	insertAccessRequestStmt.run(id, tokenName, serviceName, reason ?? null)
	return getAccessRequestStmt.get(id)!
}

export function listAccessRequests(status?: 'pending' | 'approved' | 'denied'): AccessRequestRow[] {
	return status ? listAccessRequestsByStatusStmt.all(status) : listAccessRequestsStmt.all()
}

export function listAccessRequestsForToken(tokenName: string): AccessRequestRow[] {
	return listAccessRequestsForTokenStmt.all(tokenName)
}

export function decideAccessRequest(id: string, status: 'approved' | 'denied', decidedBy: string): AccessRequestRow | null {
	const existing = getAccessRequestStmt.get(id)
	if (!existing) return null

	decideAccessRequestStmt.run(status, decidedBy, id)
	return getAccessRequestStmt.get(id)!
}

// --- Sessions ---

export interface SessionRow {
	id: string
	access_token: string
	user_id: string
	email: string
	name: string
	grants: string
	created_at: string
	expires_at: string
	refreshed_at: string
	stale: number
}

const ttlModifier = `+${config.sessionTtlHours} hours`

const insertSessionStmt = db.prepare<void, [string, string, string, string, string, string, string]>(
	"INSERT INTO sessions (id, access_token, user_id, email, name, grants, expires_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now', ?))",
)
const getSessionStmt = db.prepare<SessionRow, [string]>(
	"SELECT *, (refreshed_at < datetime('now', '-10 minutes')) AS stale FROM sessions WHERE id = ? AND expires_at > datetime('now')",
)
const touchSessionStmt = db.prepare<void, [string, string]>("UPDATE sessions SET expires_at = datetime('now', ?) WHERE id = ?")
const refreshSessionGrantsStmt = db.prepare<void, [string, string]>(
	"UPDATE sessions SET grants = ?, refreshed_at = datetime('now') WHERE id = ?",
)
const markSessionRefreshedStmt = db.prepare<void, [string]>("UPDATE sessions SET refreshed_at = datetime('now') WHERE id = ?")
const deleteSessionStmt = db.prepare<void, [string]>('DELETE FROM sessions WHERE id = ?')
const pruneSessionsStmt = db.prepare<void, []>("DELETE FROM sessions WHERE expires_at <= datetime('now')")

export function createSession(data: {
	accessToken: string
	user: { id: string; email: string; name: string }
	grants: Record<string, boolean>
}): string {
	pruneSessionsStmt.run()
	const id = crypto.randomUUID()
	insertSessionStmt.run(id, data.accessToken, data.user.id, data.user.email, data.user.name, JSON.stringify(data.grants), ttlModifier)
	return id
}

export function getSession(id: string): SessionRow | null {
	return getSessionStmt.get(id) ?? null
}

// Sliding expiry: every authenticated request pushes expiry out by the full TTL
export function touchSession(id: string): void {
	touchSessionStmt.run(ttlModifier, id)
}

export function refreshSessionGrants(id: string, grants: Record<string, boolean>): void {
	refreshSessionGrantsStmt.run(JSON.stringify(grants), id)
}

export function markSessionRefreshed(id: string): void {
	markSessionRefreshedStmt.run(id)
}

export function deleteSession(id: string): void {
	deleteSessionStmt.run(id)
}
