// Ad-hoc smoke test for the agent-token.ts provisioning CLI: order-independent --can-install
// parsing on `add` (flag before or after the services argument must produce the same entry),
// and `list` surfacing canInstall per token so an operator auditing tokens cannot miss a
// SYSTEM-RCE-equivalent grant. Run via `bun run scripts/smoke-agent-token.ts`.
export {} // keeps this a module despite no top-level import/export otherwise needed

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const eq = (a: unknown, b: unknown, msg: string) => {
	if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`)
}
const ok = (cond: boolean, msg: string) => {
	if (!cond) throw new Error(msg)
}

const script = join(import.meta.dir, 'agent-token.ts')
const smokeDir = mkdtempSync(join(tmpdir(), 'warden-smoke-agent-token-'))
const tokensPath = join(smokeDir, 'agent-tokens.json')

// agent-token.ts pulls in src/shared/config via src/auth/agentTokens, which requires these set
const passwordHash = await Bun.password.hash('smoke-test-password')

async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
	const proc = Bun.spawn([process.execPath, script, ...args], {
		env: {
			...process.env,
			AGENT_TOKENS_PATH: tokensPath,
			COOKIE_SECRET: '0123456789abcdef0123456789abcdef',
			AUTH_PASSWORD_HASH: passwordHash,
		},
		stdout: 'pipe',
		stderr: 'pipe',
	})
	const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
	return { code: await proc.exited, out, err }
}

type Entry = { name: string; token: string; services: string[]; canInstall?: boolean }
const readEntry = (name: string): Entry => {
	const file = JSON.parse(readFileSync(tokensPath, 'utf8')) as { tokens: Entry[] }
	const entry = file.tokens.find(e => e.name === name)
	if (!entry) throw new Error(`no token entry named '${name}'`)
	return entry
}

// --- add: --can-install after the services argument (the documented order) ---
const afterOrder = await run(['add', 'flag-after', 'svc-a,svc-b', '--can-install'])
eq(afterOrder.code, 0, 'add with --can-install after services must exit 0')
const entryAfter = readEntry('flag-after')
eq(entryAfter.services, ['svc-a', 'svc-b'], 'flag-after services parsed correctly')
eq(entryAfter.canInstall, true, 'flag-after canInstall set')

// --- add: --can-install before the services argument must parse identically ---
const beforeOrder = await run(['add', 'flag-before', '--can-install', 'svc-a,svc-b'])
eq(beforeOrder.code, 0, 'add with --can-install before services must exit 0')
const entryBefore = readEntry('flag-before')
eq(entryBefore.services, entryAfter.services, 'flag-before services match flag-after services')
eq(entryBefore.canInstall, entryAfter.canInstall, 'flag-before canInstall matches flag-after canInstall')
eq({ services: entryBefore.services, canInstall: entryBefore.canInstall }, { services: entryAfter.services, canInstall: entryAfter.canInstall }, 'flag position does not change the stored entry (token excluded, it is random per entry)')

// --- add: no --can-install at all still works and defaults to no install capability ---
const noFlag = await run(['add', 'no-flag', 'svc-a,svc-b'])
eq(noFlag.code, 0, 'add without --can-install must exit 0')
const entryNoFlag = readEntry('no-flag')
eq(entryNoFlag.canInstall, undefined, 'no --can-install means canInstall is left unset')

// --- list: canInstall indicator present for both install-capable and plain tokens ---
const listed = await run(['list'])
eq(listed.code, 0, 'list must exit 0')
ok(listed.out.includes('flag-after\tcanInstall: true\tsvc-a, svc-b'), 'list shows canInstall: true for an install-capable token')
ok(listed.out.includes('flag-before\tcanInstall: true\tsvc-a, svc-b'), 'list shows canInstall: true regardless of flag position at add time')
ok(listed.out.includes('no-flag\tcanInstall: false\tsvc-a, svc-b'), 'list shows canInstall: false for a token without the flag')

console.log('smoke-agent-token ok')
process.exit(0)
