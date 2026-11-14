// Provisions bearer tokens for the /v1 agent-restart API (src/routes/agentApi.ts).
// Usage:
//   bun run scripts/agent-token.ts add <name> <service1,service2,...> [--can-install]
//   bun run scripts/agent-token.ts list
//   bun run scripts/agent-token.ts remove <name>
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import { isDenylisted } from '../src/auth/agentTokens'

const path = process.env.AGENT_TOKENS_PATH ?? './data/agent-tokens.json'

type Entry = { name: string; token: string; services: string[]; canInstall?: boolean }
type TokenFile = { tokens: Entry[] }

function load(): TokenFile {
	if (!existsSync(path)) return { tokens: [] }
	try {
		const parsed = JSON.parse(readFileSync(path, 'utf8')) as TokenFile
		return Array.isArray(parsed.tokens) ? parsed : { tokens: [] }
	} catch {
		return { tokens: [] }
	}
}

function save(file: TokenFile): void {
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(path, JSON.stringify(file, null, '\t') + '\n')
}

const [, , cmd, ...rest] = process.argv

if (cmd === 'list') {
	const file = load()
	if (file.tokens.length === 0) console.log('(no tokens provisioned)')
	for (const e of file.tokens) console.log(`${e.name}\tcanInstall: ${e.canInstall === true}\t${e.services.join(', ')}`)
	process.exit(0)
}

if (cmd === 'remove') {
	const name = rest[0]
	if (!name) {
		console.error('Usage: bun run scripts/agent-token.ts remove <name>')
		process.exit(1)
	}
	const file = load()
	const before = file.tokens.length
	file.tokens = file.tokens.filter(e => e.name !== name)
	if (file.tokens.length === before) {
		console.error(`No token named '${name}'`)
		process.exit(1)
	}
	save(file)
	console.log(`Removed token '${name}'`)
	process.exit(0)
}

if (cmd === 'add') {
	// --can-install is a flag, not a positional argument: scan for it and strip it out
	// before assigning name/services positionally, so it works before or after services.
	const canInstall = rest.includes('--can-install')
	const positional = rest.filter(a => a !== '--can-install')
	const name = positional[0]
	const servicesArg = positional[1]
	if (!name || !servicesArg) {
		console.error('Usage: bun run scripts/agent-token.ts add <name> <service1,service2,...> [--can-install]')
		process.exit(1)
	}

	const requested = servicesArg.split(',').map(s => s.trim()).filter(Boolean)
	const services = requested.filter(s => !isDenylisted(s))
	const dropped = requested.filter(s => isDenylisted(s))
	if (dropped.length > 0) {
		console.error(`Skipping denylisted service(s), never restartable via this API: ${dropped.join(', ')}`)
	}
	if (services.length === 0) {
		console.error('At least one non-denylisted service name is required')
		process.exit(1)
	}

	const file = load()
	if (file.tokens.some(e => e.name === name)) {
		console.error(`Token '${name}' already exists — remove it first to rotate`)
		process.exit(1)
	}

	const token = `wat_${randomBytes(24).toString('hex')}`
	const entry: Entry = { name, token, services }
	if (canInstall) entry.canInstall = true
	file.tokens.push(entry)
	save(file)

	console.log(`Token for '${name}': ${token}`)
	console.log(`Allowed services: ${services.join(', ')}`)
	console.log(`Can install: ${canInstall}`)
	console.log(`Written to ${path}`)
	process.exit(0)
}

console.error('Usage: bun run scripts/agent-token.ts <add|list|remove> ...')
process.exit(1)

export {}
