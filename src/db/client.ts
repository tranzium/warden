import { Database } from 'bun:sqlite'
import { readFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { config } from '../shared/config'

const dbDir = dirname(resolve(config.dbPath))
mkdirSync(dbDir, { recursive: true })

const db = new Database(config.dbPath, { create: true })
db.exec('PRAGMA journal_mode = WAL')
db.exec(readFileSync(resolve(import.meta.dir, 'schema.sql'), 'utf8'))

export interface ServiceRow {
	id: string
	name: string
	display: string | null
	description: string | null
	group_name: string | null
	managed: number
	created_at: string
}

const listStmt = db.prepare<ServiceRow, []>('SELECT * FROM services ORDER BY group_name, name')
const getStmt = db.prepare<ServiceRow, [string]>('SELECT * FROM services WHERE name = ?')
const insertStmt = db.prepare<void, [string, string, string | null, string | null, string | null, number]>(
	'INSERT INTO services (id, name, display, description, group_name, managed) VALUES (?, ?, ?, ?, ?, ?)',
)
const deleteStmt = db.prepare<void, [string]>('DELETE FROM services WHERE name = ?')
const updateStmt = db.prepare<void, [string | null, string | null, string | null, number, string]>(
	'UPDATE services SET display = ?, description = ?, group_name = ?, managed = ? WHERE name = ?',
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
}): ServiceRow {
	const id = crypto.randomUUID()
	insertStmt.run(
		id,
		data.name,
		data.display ?? null,
		data.description ?? null,
		data.group_name ?? null,
		data.managed !== false ? 1 : 0,
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
	},
): ServiceRow | null {
	const existing = getStmt.get(name)
	if (!existing) return null

	const display = data.display !== undefined ? data.display : existing.display
	const description = data.description !== undefined ? data.description : existing.description
	const group_name = data.group_name !== undefined ? data.group_name : existing.group_name
	const managed = data.managed !== undefined ? (data.managed ? 1 : 0) : existing.managed

	updateStmt.run(display, description, group_name, managed, name)
	return getStmt.get(name)!
}
