// Ad-hoc smoke test for the onboarding script: dry-run output shape for the Poe presets and
// a --spec file, plus the pure spec/args/plan helpers. Dry-run only: no request is sent and
// the token sentinel must never reach the output. Run via `bun run scripts/smoke-onboard.ts`.
export {} // dynamic imports below do not mark this as a module on their own

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const O = await import('./onboard-agentic-service')

const eq = (a: unknown, b: unknown, msg: string) => {
	if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`)
}
const ok = (cond: boolean, msg: string) => {
	if (!cond) throw new Error(msg)
}

const TOKEN_SENTINEL = 'wat_smoke_onboard_sentinel'
const URL = 'http://warden.test'
const script = join(import.meta.dir, 'onboard-agentic-service.ts')

async function run(args: string[], withToken = true): Promise<{ code: number; out: string; err: string }> {
	const env: Record<string, string | undefined> = { ...process.env, WARDEN_URL: URL, WARDEN_AGENT_TOKEN: TOKEN_SENTINEL }
	if (!withToken) delete env.WARDEN_AGENT_TOKEN
	const proc = Bun.spawn([process.execPath, script, ...args], {
		env,
		stdout: 'pipe',
		stderr: 'pipe',
	})
	const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
	return { code: await proc.exited, out, err }
}

// --- parseArgs ---
eq(O.parseArgs([]), { live: false, specFiles: [] }, 'no args is dry-run with presets')
eq(O.parseArgs(['--live']), { live: true, specFiles: [] }, '--live is parsed')
eq(O.parseArgs(['--spec', 'a.json', '--spec', 'b.json']), { live: false, specFiles: ['a.json', 'b.json'] }, '--spec repeats in order')
let threw = false
try {
	O.parseArgs(['--spec'])
} catch {
	threw = true
}
ok(threw, '--spec without a path must throw')
threw = false
try {
	O.parseArgs(['--bogus'])
} catch {
	threw = true
}
ok(threw, 'unknown argument must throw')

// --- parseSpec ---
threw = false
try {
	O.parseSpec([])
} catch {
	threw = true
}
ok(threw, 'array spec must throw')
threw = false
try {
	O.parseSpec({ program: 'x' })
} catch {
	threw = true
}
ok(threw, 'spec without name must throw')
threw = false
try {
	O.parseSpec({ name: 'x' })
} catch {
	threw = true
}
ok(threw, 'spec without program must throw')

// --- buildPlan: installs in order, bodies verbatim, restart-based starts after every install ---
const plan = O.buildPlan(O.POE_SPECS)
const installs = plan.requests.filter(r => r.body)
const starts = plan.requests.filter(r => !r.body)
eq(installs.map(i => i.body!.name), ['poe-monitor', 'poe-dash'], 'install order is monitor then dash')
eq(installs.map(i => i.path), ['/v1/services', '/v1/services'], 'installs share the agent install path')
eq(starts.map(s => s.path), ['/v1/services/poe-monitor/restart?live=1', '/v1/services/poe-dash/restart?live=1'], 'starts use restart route with live=1')
eq(plan.requests.map(r => r.label), ['install poe-monitor', 'install poe-dash', 'start poe-monitor', 'start poe-dash'], 'every install precedes every start')
eq(installs[0]!.body!.group_name, 'agentic', 'monitor group')
ok(installs.every(i => i.body!.env === undefined), 'presets send no env: each service reads its own .env')

// --- dry-run process: default presets ---
const dry = await run([])
eq(dry.code, 0, 'dry-run exits 0')
ok(dry.out.includes('DRY RUN'), 'dry-run banner present')
ok(!dry.out.includes(TOKEN_SENTINEL), 'token value must never be printed')
ok(dry.out.includes('Authorization: Bearer <WARDEN_AGENT_TOKEN>'), 'auth header shown as placeholder')
ok(dry.out.includes(`1. install poe-monitor: POST ${URL}/v1/services\n`), 'first install request line')
ok(dry.out.includes(`2. install poe-dash: POST ${URL}/v1/services\n`), 'second install request line')
ok(dry.out.includes(`body: ${JSON.stringify(O.POE_MONITOR)}`), 'monitor body exact')
ok(dry.out.includes(`body: ${JSON.stringify(O.POE_DASH)}`), 'dash body exact')
const monitorAt = dry.out.indexOf('"name":"poe-monitor"')
const dashAt = dry.out.indexOf('"name":"poe-dash"')
ok(monitorAt > 0 && dashAt > monitorAt, 'monitor install printed before dash install')
ok(dry.out.includes('"group_name":"agentic"'), 'group_name agentic in bodies')
ok(!dry.out.includes('"env"'), 'no env field in any install body')
ok(dry.out.includes('Environment variables are not sent'), 'dry-run banner explains env comes from .env')
ok(dry.out.includes(`3. start poe-monitor: POST ${URL}/v1/services/poe-monitor/restart?live=1\n`), 'monitor start is restart live=1')
ok(dry.out.includes(`4. start poe-dash: POST ${URL}/v1/services/poe-dash/restart?live=1\n`), 'dash start is restart live=1')
ok(!dry.out.includes('NOT SENT'), 'no start is marked not sent')

// --- dry-run process: --spec file ---
const dir = mkdtempSync(join(tmpdir(), 'warden-smoke-onboard-'))
const custom = { name: 'custom-svc', program: 'C:\\tools\\svc.exe', group_name: 'agentic' }
const specPath = join(dir, 'custom.json')
writeFileSync(specPath, JSON.stringify(custom))
const fromFile = await run(['--spec', specPath])
eq(fromFile.code, 0, '--spec dry-run exits 0')
ok(fromFile.out.includes(`body: ${JSON.stringify(custom)}`), '--spec body exact')
ok(!fromFile.out.includes('poe-monitor'), '--spec replaces the presets')
ok(fromFile.out.includes(`1. install custom-svc: POST ${URL}/v1/services\n`) && !fromFile.out.includes('2. install'), 'one install for one spec')
ok(fromFile.out.includes(`2. start custom-svc: POST ${URL}/v1/services/custom-svc/restart?live=1`), 'one spec also gets a restart start')

const badPath = join(dir, 'bad.json')
writeFileSync(badPath, JSON.stringify({ name: 'no-program' }))
const bad = await run(['--spec', badPath])
ok(bad.code !== 0, 'invalid spec file must exit non-zero')
ok(bad.err.includes('spec.program is required'), 'invalid spec names the missing field')

const malformedPath = join(dir, 'malformed.json')
writeFileSync(malformedPath, '{ "name": "broken", ')
const malformed = await run(['--spec', malformedPath])
ok(malformed.code === 1, 'malformed JSON spec must exit 1')
ok(malformed.err.startsWith('onboard-agentic-service: ') && malformed.err.includes('is not valid JSON'), 'malformed JSON gets a clean message')
ok(!malformed.err.includes('SyntaxError') && !malformed.err.includes('    at '), 'malformed JSON must not dump a stack trace')

// --live refusal before any request: the token is absent, so nothing is sent
const noToken = await run(['--live'], false)
ok(noToken.code === 1, '--live without WARDEN_AGENT_TOKEN must exit 1')
ok(noToken.err.includes('refusing --live: WARDEN_AGENT_TOKEN is not set'), '--live without token names the missing variable')
ok(!noToken.out.includes('install') && !noToken.out.includes('start'), '--live without token sends nothing')

console.log('smoke-onboard ok')
process.exit(0)
