import { readFileSync } from 'node:fs'
import { createHash, timingSafeEqual } from 'node:crypto'
import { config } from '../shared/config'
import { isSelf } from '../nssm/client'

export type AgentToken = {
	name: string
	services: string[]
	canInstall?: boolean
}

type TokenFileEntry = { name: string; token: string; services: string[]; canInstall?: boolean }

// Taskflow rails (tf-*) are the operator's own — never restartable via this API,
// regardless of what a token's config lists. Same for warden itself (self-restart
// has its own dashboard-only path).
export function isDenylisted(name: string): boolean {
	const lower = name.toLowerCase()
	if (lower.startsWith('tf-')) return true
	if (isSelf(name)) return true
	return false
}

function digest(value: string): Buffer {
	return createHash('sha256').update(value).digest()
}

// Re-read on every call (no caching) so the operator can provision or revoke
// tokens by editing the file — no warden restart required.
function loadTokens(): TokenFileEntry[] {
	try {
		const text = readFileSync(config.agentTokensPath, 'utf8')
		const parsed = JSON.parse(text) as { tokens?: unknown }
		return Array.isArray(parsed.tokens) ? (parsed.tokens as TokenFileEntry[]) : []
	} catch {
		return []
	}
}

// Timing-safe compare over fixed-length digests — avoids leaking token length/prefix.
export function resolveAgentToken(rawToken: string): AgentToken | null {
	const provided = digest(rawToken)
	for (const entry of loadTokens()) {
		if (typeof entry.token !== 'string' || typeof entry.name !== 'string' || !Array.isArray(entry.services)) continue
		if (timingSafeEqual(provided, digest(entry.token))) {
			return { name: entry.name, services: entry.services, canInstall: entry.canInstall === true }
		}
	}
	return null
}

// Install/configure is not exempt from the existing per-service allowlist: a token must be
// explicitly provisioned with the exact service name, carry canInstall, and the name must not
// be denylisted. All three gates are independent of one another.
export function isAllowedToInstall(caller: AgentToken, name: string): boolean {
	if (!caller.canInstall) return false
	if (isDenylisted(name)) return false
	return caller.services.some(s => s.toLowerCase() === name.toLowerCase())
}
