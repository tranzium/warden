// Ad-hoc smoke test for the install API parameters: env, restartDelayMs, rotateBytes.
// Pure helpers plus installHandler validation paths that fail before any NSSM call.
// Run via `bun run scripts/smoke-install.ts`.
export {} // dynamic imports below don't mark this as a module on their own

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Route modules pull in the DB client; keep it off the working tree
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'warden-smoke-install-')), 'warden.db')
process.env.COOKIE_SECRET = '0123456789abcdef0123456789abcdef'
process.env.AUTH_PASSWORD_HASH = await Bun.password.hash('smoke-test-password')

const S = await import('../src/routes/services')
const eq = (a: unknown, b: unknown, msg: string) => {
	if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: ${JSON.stringify(a)}`)
}

// envLines: optional object of string values -> KEY=VALUE lines
eq(S.envLines(undefined), [], 'omitted env')
eq(S.envLines(null), [], 'null env')
eq(S.envLines({}), [], 'empty env object adds no lines')
eq(S.envLines({ A: '1', B: 'x=y z' }), ['A=1', 'B=x=y z'], 'lines keep value verbatim')
eq(S.envLines({ EMPTY: '' }), ['EMPTY='], 'empty value allowed')
eq(S.envLines([]), undefined, 'array env rejected')
eq(S.envLines('A=1'), undefined, 'string env rejected')
eq(S.envLines({ A: 1 }), undefined, 'non-string value rejected')
eq(S.envLines({ A: null }), undefined, 'null value rejected')
eq(S.envLines({ 'A=B': '1' }), undefined, 'key containing = rejected')
eq(S.envLines({ 'A B': '1' }), undefined, 'key containing whitespace rejected')
eq(S.envLines({ '': '1' }), undefined, 'empty key rejected')

// wholeNumber: fallback when omitted, JSON number or digit string, bounded
eq(S.wholeNumber(undefined, 1500, 0), 1500, 'omitted restartDelayMs falls back')
eq(S.wholeNumber(null, 1048576, 1), 1048576, 'null rotateBytes falls back')
eq(S.wholeNumber(250, 1500, 0), 250, 'number accepted')
eq(S.wholeNumber('250', 1500, 0), 250, 'digit string accepted')
eq(S.wholeNumber(' 250 ', 1500, 0), 250, 'padded digit string accepted')
eq(S.wholeNumber(0, 1500, 0), 0, 'zero allowed when min is 0')
eq(S.wholeNumber(0, 1048576, 1), undefined, 'zero rejected when min is 1')
eq(S.wholeNumber(-1, 1500, 0), undefined, 'negative rejected')
eq(S.wholeNumber(1.5, 1500, 0), undefined, 'fraction rejected')
eq(S.wholeNumber('1.5', 1500, 0), undefined, 'fraction string rejected')
eq(S.wholeNumber('1e3', 1500, 0), undefined, 'exponent string rejected')
eq(S.wholeNumber('', 1500, 0), undefined, 'empty string rejected')
eq(S.wholeNumber('abc', 1500, 0), undefined, 'non-numeric string rejected')
eq(S.wholeNumber(true, 1500, 0), undefined, 'boolean rejected')
eq(S.wholeNumber(Number.MAX_SAFE_INTEGER + 2, 1500, 0), undefined, 'unsafe integer rejected')

// installHandler: validation fails before any NSSM or Windows service call
const ctx = (grants: Record<string, boolean>) => ({ accessToken: 't', user: { id: '1', email: 'e@x', name: 'n' }, grants })
const installReq = (body: Record<string, unknown>) =>
	new Request('http://x/services/install', { method: 'POST', body: JSON.stringify({ name: 'warden-smoke-svc', program: process.execPath, ...body }) })
const install = { 'services.install': true }

const denied = await S.installHandler(ctx({}), installReq({}))
if (denied.status !== 403) throw new Error('install without services.install must be 403, got ' + denied.status)

for (const bad of [{ env: ['A=1'] }, { env: { 'A=B': '1' } }, { env: { A: 1 } }]) {
	const r = await S.installHandler(ctx(install), installReq(bad))
	if (r.status !== 422) throw new Error(`invalid env ${JSON.stringify(bad)} must be 422, got ${r.status}`)
}
for (const bad of [{ restartDelayMs: -5 }, { restartDelayMs: 'soon' }, { restartDelayMs: 1.5 }]) {
	const r = await S.installHandler(ctx(install), installReq(bad))
	if (r.status !== 422) throw new Error(`invalid restartDelayMs ${JSON.stringify(bad)} must be 422, got ${r.status}`)
}
for (const bad of [{ rotateBytes: 0 }, { rotateBytes: '-1' }, { rotateBytes: '1MB' }]) {
	const r = await S.installHandler(ctx(install), installReq(bad))
	if (r.status !== 422) throw new Error(`invalid rotateBytes ${JSON.stringify(bad)} must be 422, got ${r.status}`)
}

console.log('smoke-install ok')
process.exit(0)
