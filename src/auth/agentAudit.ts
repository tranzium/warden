import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { config } from '../shared/config'

export type AgentAuditEntry = {
	token: string
	action: 'auth' | 'list' | 'status' | 'restart'
	service: string | null
	live?: boolean
	result: string
	status: number
}

// Append-only JSONL audit trail for every /v1 call — auth failures included.
// Best-effort: a logging failure must never block the request it's auditing.
export function auditLog(entry: AgentAuditEntry): void {
	const line = JSON.stringify({ ts: new Date().toISOString(), ...entry })
	try {
		mkdirSync(dirname(config.agentAuditLogPath), { recursive: true })
		appendFileSync(config.agentAuditLogPath, line + '\n')
	} catch (e) {
		console.error('agent-audit: failed to write audit log entry', e)
	}
}
