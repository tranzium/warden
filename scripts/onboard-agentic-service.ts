// Onboards agentic services into Warden through the bearer-token agent API (POST /v1/services).
// Dry-run by default: prints the requests it would send and makes no network calls.
// Pass --live with WARDEN_AGENT_TOKEN set to send the installs (WARDEN_URL defaults to DEFAULT_URL).
// Usage:
//   bun run scripts/onboard-agentic-service.ts [--spec <file.json>]... [--live]
// Without --spec, onboards the Poe presets in order: poe-monitor, then poe-dash.
// Starting is not exposed to agent tokens yet: start calls are listed, never sent.

import { readFileSync } from 'node:fs'

export type ServiceSpec = {
	name: string
	program: string
	args?: string
	directory?: string
	display?: string
	description?: string
	start?: string
	group_name?: string
	env?: Record<string, string>
	restartDelayMs?: number
	rotateBytes?: number
}

export type PlannedInstall = { method: 'POST'; path: string; body: ServiceSpec }
export type Plan = { installs: PlannedInstall[]; starts: string[] }
export type Args = { live: boolean; specFiles: string[] }

export const DEFAULT_URL = 'http://localhost:3004'
const INSTALL_PATH = '/v1/services'

const POE_COMMON = {
	program: 'D:\\bin\\bun.exe',
	directory: 'D:\\projects\\poe',
	start: 'auto',
	group_name: 'agentic',
	restartDelayMs: 5000,
	rotateBytes: 10485760,
}

export const POE_MONITOR: ServiceSpec = {
	name: 'poe-monitor',
	...POE_COMMON,
	args: 'run src/monitor/main.ts',
	display: 'Poe Monitor',
	description: 'Poe gen1 - read-only system monitor (collectors, rules, db writer)',
	env: {
		POE_HYGIENE_DIRS: 'C:\\Users\\Devan\\Downloads',
		POE_LAUNCHED_FROM_DIRS: 'C:\\Users\\Devan\\Downloads,C:\\Users\\Devan\\AppData\\Local\\Temp',
	},
}

export const POE_DASH: ServiceSpec = {
	name: 'poe-dash',
	...POE_COMMON,
	args: 'run src/dash/main.ts',
	display: 'Poe Dashboard',
	description: "Poe gen1 - localhost status dashboard over the monitor's database",
	env: { POE_DASH_PORT: '3015' },
}

export const POE_SPECS: ServiceSpec[] = [POE_MONITOR, POE_DASH]

export function parseSpec(raw: unknown): ServiceSpec {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('spec must be a JSON object')
	const spec = raw as Partial<ServiceSpec>
	if (typeof spec.name !== 'string' || spec.name === '') throw new Error('spec.name is required')
	if (typeof spec.program !== 'string' || spec.program === '') throw new Error(`spec.program is required (${spec.name})`)
	return raw as ServiceSpec
}

export function parseArgs(argv: string[]): Args {
	const specFiles: string[] = []
	let live = false
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!
		if (arg === '--live') live = true
		else if (arg === '--spec') {
			const file = argv[++i]
			if (!file) throw new Error('--spec needs a file path')
			specFiles.push(file)
		} else throw new Error(`unknown argument: ${arg}`)
	}
	return { live, specFiles }
}

export function buildPlan(specs: ServiceSpec[]): Plan {
	return {
		installs: specs.map(body => ({ method: 'POST', path: INSTALL_PATH, body })),
		starts: specs.map(spec => spec.name),
	}
}

export function describePlan(plan: Plan, baseUrl: string): string[] {
	const installs = plan.installs.flatMap((req, i) => [
		`${i + 1}. ${req.method} ${baseUrl}${req.path}`,
		'   Authorization: Bearer <WARDEN_AGENT_TOKEN>',
		'   Content-Type: application/json',
		`   body: ${JSON.stringify(req.body)}`,
	])
	const offset = plan.installs.length
	const starts = plan.starts.map((name, i) =>
		`${offset + i + 1}. start ${name}: POST ${baseUrl}/services/${encodeURIComponent(name)}/start (dashboard session only, no agent-api route) - NOT SENT`,
	)
	return [...installs, ...starts]
}

export async function sendInstalls(
	plan: Plan,
	baseUrl: string,
	token: string,
	send: typeof fetch = fetch,
): Promise<{ ok: boolean; lines: string[] }> {
	const lines: string[] = []
	for (const req of plan.installs) {
		const res = await send(`${baseUrl}${req.path}`, {
			method: req.method,
			headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify(req.body),
		})
		const text = await res.text()
		lines.push(`${res.status} POST ${req.body.name}: ${text}`)
		if (!res.ok) return { ok: false, lines }
	}
	return { ok: true, lines }
}

function loadSpec(file: string): ServiceSpec {
	return parseSpec(JSON.parse(readFileSync(file, 'utf8')))
}

async function main(): Promise<number> {
	const args = parseArgs(process.argv.slice(2))
	const specs = args.specFiles.length > 0 ? args.specFiles.map(loadSpec) : POE_SPECS
	const plan = buildPlan(specs)
	const baseUrl = process.env.WARDEN_URL ?? DEFAULT_URL

	if (!args.live) {
		console.log('onboard-agentic-service: DRY RUN (no requests sent). Pass --live with WARDEN_AGENT_TOKEN set to send the installs:')
		for (const line of describePlan(plan, baseUrl)) console.log(line)
		return 0
	}

	const token = process.env.WARDEN_AGENT_TOKEN
	if (!token) {
		console.error('onboard-agentic-service: refusing --live: WARDEN_AGENT_TOKEN is not set')
		return 1
	}
	const sent = await sendInstalls(plan, baseUrl, token)
	for (const line of sent.lines) console.log(line)
	for (const line of describePlan({ installs: [], starts: plan.starts }, baseUrl)) console.log(line)
	return sent.ok ? 0 : 1
}

if (import.meta.main) process.exit(await main())
