import { AsyncLocalStorage } from 'node:async_hooks'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { config } from '../shared/config'

export type AgentAuditEntry = {
	token: string
	action: 'auth' | 'list' | 'status' | 'restart' | 'install' | 'configure' | 'initialize' | 'tools_list' | 'rpc_error' | 'access_request'
	service: string | null
	live?: boolean
	group_name?: string
	// MCP method or tool name behind an /mcp rpc_error entry, length-capped by the caller
	detail?: string
	result: string
	status: number
}

export type AuditSurface = 'v1' | 'mcp' | 'dashboard'

const surfaceStore = new AsyncLocalStorage<AuditSurface>()

// Tags every audit entry written while fn runs with the API surface the request arrived
// through, without threading a parameter through the /v1 handlers that /mcp reuses.
export function withAuditSurface<T>(surface: AuditSurface, fn: () => T): T {
	return surfaceStore.run(surface, fn)
}

// Append-only JSONL audit trail for every /v1 call and /mcp call — auth failures included.
// Entries outside a withAuditSurface scope come from the /v1 routes, the only other caller.
// Best-effort: a logging failure must never block the request it's auditing.
export function auditLog(entry: AgentAuditEntry): void {
	const line = JSON.stringify({ ts: new Date().toISOString(), surface: surfaceStore.getStore() ?? 'v1', ...entry })
	try {
		mkdirSync(dirname(config.agentAuditLogPath), { recursive: true })
		appendFileSync(config.agentAuditLogPath, line + '\n')
	} catch (e) {
		console.error('agent-audit: failed to write audit log entry', e)
	}
}
