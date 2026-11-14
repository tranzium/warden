// Onboards agentic services into Warden through the bearer-token agent API (POST /v1/services).
// Dry-run by default: prints the requests it would send and makes no network calls.
// Pass --live with WARDEN_AGENT_TOKEN set to send the requests (WARDEN_URL defaults to DEFAULT_URL).
// Usage:
//   bun run scripts/onboard-agentic-service.ts [--spec <file.json>]... [--live]
// Without --spec, onboards the Poe presets in order: poe-monitor, then poe-dash.
// Each service is installed, then started via POST /v1/services/:name/restart?live=1.
// Environment variables are not sent: each service reads its own .env from its working directory.

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

export type PlannedRequest = { label: string; method: 'POST'; path: string; body?: ServiceSpec }
export type Plan = { requests: PlannedRequest[] }
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
}

export const POE_DASH: ServiceSpec = {
	name: 'poe-dash',
	...POE_COMMON,
	args: 'run src/dash/main.ts',
	display: 'Poe Dashboard',
	description: "Poe gen1 - localhost status dashboard over the monitor's database",
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

// Installs first (in spec order), then a start per service via the agent restart route:
// Assumed: NSSM restart is stop-then-start, so it should start a freshly installed (stopped)
// service. Unverified: confirm on the live run before relying on this.
export function buildPlan(specs: ServiceSpec[]): Plan {
	const installs = specs.map(body => ({ label: `install ${body.name}`, method: 'POST' as const, path: INSTALL_PATH, body }))
	const starts = specs.map(spec => ({
		label: `start ${spec.name}`,
		method: 'POST' as const,
		path: `/v1/services/${encodeURIComponent(spec.name)}/restart?live=1`,
	}))
	return { requests: [...installs, ...starts] }
}

export function describePlan(plan: Plan, baseUrl: string): string[] {
	return plan.requests.flatMap((req, i) => {
		const head = `${i + 1}. ${req.label}: ${req.method} ${baseUrl}${req.path}`
		if (!req.body) return [head, '   Authorization: Bearer <WARDEN_AGENT_TOKEN>']
		return [
			head,
			'   Authorization: Bearer <WARDEN_AGENT_TOKEN>',
			'   Content-Type: application/json',
			`   body: ${JSON.stringify(req.body)}`,
		]
	})
}

export async function sendPlan(
	plan: Plan,
	baseUrl: string,
	token: string,
	send: typeof fetch = fetch,
): Promise<{ ok: boolean; lines: string[] }> {
	const lines: string[] = []
	for (const req of plan.requests) {
		const res = await send(`${baseUrl}${req.path}`, {
			method: req.method,
			headers: {
				Authorization: `Bearer ${token}`,
				...(req.body ? { 'Content-Type': 'application/json' } : {}),
			},
			body: req.body ? JSON.stringify(req.body) : undefined,
		})
		lines.push(`${res.status} ${req.label}: ${await res.text()}`)
		if (!res.ok) return { ok: false, lines }
	}
	return { ok: true, lines }
}

function loadSpec(file: string): ServiceSpec {
	const text = readFileSync(file, 'utf8')
	let raw: unknown
	try {
		raw = JSON.parse(text)
	} catch (e) {
		throw new Error(`${file} is not valid JSON: ${(e as Error).message}`)
	}
	return parseSpec(raw)
}

async function main(): Promise<number> {
	let args: Args
	let specs: ServiceSpec[]
	try {
		args = parseArgs(process.argv.slice(2))
		specs = args.specFiles.length > 0 ? args.specFiles.map(loadSpec) : POE_SPECS
	} catch (e) {
		console.error(`onboard-agentic-service: ${(e as Error).message}`)
		return 1
	}
	const plan = buildPlan(specs)
	const baseUrl = process.env.WARDEN_URL ?? DEFAULT_URL

	if (!args.live) {
		console.log('onboard-agentic-service: DRY RUN (no requests sent). Pass --live with WARDEN_AGENT_TOKEN set to send the requests:')
		console.log('Environment variables are not sent; each service reads its own .env from its working directory.')
		for (const line of describePlan(plan, baseUrl)) console.log(line)
		return 0
	}

	const token = process.env.WARDEN_AGENT_TOKEN
	if (!token) {
		console.error('onboard-agentic-service: refusing --live: WARDEN_AGENT_TOKEN is not set')
		return 1
	}
	const sent = await sendPlan(plan, baseUrl, token)
	for (const line of sent.lines) console.log(line)
	return sent.ok ? 0 : 1
}

if (import.meta.main) process.exit(await main())
