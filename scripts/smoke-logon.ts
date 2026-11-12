// Ad-hoc smoke test for the service Log On feature: decision logic, form parsing,
// messages, secret scrubbing, and (on Windows) real account lookup. No NSSM calls.
// Run via `bun run scripts/smoke-logon.ts`.
export {} // dynamic imports below don't mark this as a module on their own

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Route modules pull in the DB client; keep it off the working tree
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'warden-smoke-logon-')), 'warden.db')
process.env.COOKIE_SECRET = '0123456789abcdef0123456789abcdef'
process.env.AUTH_PASSWORD_HASH = await Bun.password.hash('smoke-test-password')

const L = await import('../src/nssm/logon')

const user = (account: string, password = '', confirm = password) => ({ kind: 'user' as const, account, password, confirm })
const sys = { kind: 'system' as const, account: '', password: '', confirm: '' }
const eq = (a: unknown, b: unknown, msg: string) => {
	if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: ${JSON.stringify(a)}`)
}

// isLocalSystem
eq([L.isLocalSystem('LocalSystem'), L.isLocalSystem('localsystem'), L.isLocalSystem(null), L.isLocalSystem(''), L.isLocalSystem('.\\taskflow')], [true, true, true, true, false], 'isLocalSystem')

// save table (spec "Save")
eq(L.planLogon('LocalSystem', sys), { action: 'none' }, 'system->system')
eq(L.planLogon(null, sys), { action: 'none' }, 'unreadable->system')
eq(L.planLogon('.\\taskflow', sys), { action: 'set', account: 'LocalSystem', password: null }, 'user->system')
eq(L.planLogon('.\\taskflow', user('.\\taskflow')), { action: 'none' }, 'same, blank')
eq(L.planLogon('.\\taskflow', user(' .\\Taskflow ')), { action: 'none' }, 'same ignoring case/space, blank')
eq(L.planLogon('.\\taskflow', user('.\\taskflow', 'n3w')), { action: 'set', account: '.\\taskflow', password: 'n3w' }, 'rotation')
eq(L.planLogon('LocalSystem', user('.\\Devan')), { action: 'error', message: 'A password is required when changing the account' }, 'change, blank')
eq(L.planLogon('LocalSystem', user('.\\Devan', 'a', 'b')), { action: 'error', message: 'Passwords do not match' }, 'mismatch')
eq(L.planLogon('.\\Devan', user('.\\Devan', 'a', 'b')), { action: 'error', message: 'Passwords do not match' }, 'mismatch same account')
eq(L.planLogon('LocalSystem', user('  ', 'a')), { action: 'error', message: 'Account is required' }, 'empty account')
eq(L.planLogon('LocalSystem', user(' .\\Devan ', 'p w"\\')), { action: 'set', account: '.\\Devan', password: 'p w"\\' }, 'account trimmed, password untouched')

// parseLogonForm: fields logonKind, logonAccount, logonPassword, logonConfirm
const fd = (o: Record<string, string>) => {
	const f = new FormData()
	for (const [k, v] of Object.entries(o)) f.set(k, v)
	return f
}
eq(L.parseLogonForm(fd({ program: 'x' })), null, 'no logon fields -> null')
eq(L.parseLogonForm(fd({ logonKind: 'system' })), sys, 'system parse')
eq(L.parseLogonForm(fd({ logonKind: 'user', logonAccount: '.\\a', logonPassword: ' p ', logonConfirm: ' p ' })), user('.\\a', ' p ', ' p '), 'user parse keeps password whitespace')
eq(L.parseLogonForm(fd({ logonKind: 'bogus' })), null, 'unknown kind -> null')

// messages
eq(L.backslashSuggestion('./Devan'), '.\\Devan', 'suggest')
eq(L.backslashSuggestion('.\\Devan'), null, 'no suggest')
eq(L.accountNotFound('nobody'), 'Account not found: nobody', 'not found')
eq(L.accountNotFound('./Devan'), 'Account not found: ./Devan - did you mean .\\Devan?', 'not found + hint')

// scrubSecret
eq(L.scrubSecret('bad pw Error here Error', 'Error'), 'bad pw ******** here ********', 'scrub all')
eq(L.scrubSecret('text', ''), 'text', 'empty secret')
eq(L.scrubSecret('text', null), 'text', 'null secret')

// lookupAccount: real PowerShell, Windows only
if (process.platform === 'win32') {
	const me = process.env.USERNAME!
	const host = process.env.COMPUTERNAME!
	const r = await L.lookupAccount(`.\\${me}`)
	if (r?.toLowerCase() !== `${host}\\${me}`.toLowerCase()) throw new Error('local account should resolve: ' + r)
	eq(await L.lookupAccount(`./${me}`), null, 'forward slash rejected')
	eq(await L.lookupAccount('warden-no-such-user-zz'), null, 'unknown')
	eq(await L.lookupAccount("x'; exit 0; '"), null, 'quote injection is data')
	eq(await L.lookupAccount('$(exit 0)'), null, 'subexpression is data')
	eq(await L.lookupAccount(''), null, 'empty')
}

// Log on card (view)
const V = await import('../src/views/settings')
const c1 = V.logonCard('.\\taskflow', false, 'tf remote')
for (const s of ['name="logonKind"', 'value="system"', 'value="user"', 'name="logonAccount"', 'value=".\\taskflow"', 'name="logonPassword"', 'name="logonConfirm"', 'autocomplete="new-password"', 'id="logon-check"', 'data-lookup="/services/tf%20remote/logon/lookup"'])
	if (!c1.includes(s)) throw new Error('card missing ' + s)
if (/name="logon(Password|Confirm)"[^>]*value=/.test(c1)) throw new Error('password inputs must never carry a value')
if (!/value="user"[^>]*checked/.test(c1)) throw new Error('named account -> This account selected')
const c2 = V.logonCard(null, false, 'x')
if (!c2.includes('LocalSystem') || !/value="system"[^>]*checked/.test(c2)) throw new Error('unreadable -> LocalSystem selected')
const c3 = V.logonCard('LocalSystem', true, 'warden')
if (c3.includes('<input') || !c3.includes('LocalSystem')) throw new Error('self card must be read-only with no inputs')
const c4 = V.logonCard('.\\a"b<', false, 'x')
if (c4.includes('a"b<')) throw new Error('account must be escaped')

// Lookup endpoint handler (the card's Check button)
const R = await import('../src/routes/settings')
const ctx = (grants: Record<string, boolean>) => ({ accessToken: 't', user: { id: '1', email: 'e@x', name: 'n' }, grants })
const lookupReq = (account: string) => new Request(`http://x/services/svc/logon/lookup?account=${encodeURIComponent(account)}`)
const denied = await R.logonLookupHandler(ctx({ 'services.view': true }), lookupReq('.\\x'))
if (denied.status !== 403) throw new Error('lookup without services.install must be 403, got ' + denied.status)
const missing = await R.logonLookupHandler(ctx({ 'services.install': true }), lookupReq('./warden-no-such-user-zz'))
eq(await missing.json(), { resolved: null, message: 'Account not found: ./warden-no-such-user-zz - did you mean .\\warden-no-such-user-zz?' }, 'lookup not found')
if (process.platform === 'win32') {
	const found = (await (await R.logonLookupHandler(ctx({ 'services.install': true }), lookupReq(` .\\${process.env.USERNAME} `))).json()) as { resolved: string | null }
	if (found.resolved?.toLowerCase() !== `${process.env.COMPUTERNAME}\\${process.env.USERNAME}`.toLowerCase()) throw new Error('lookup should resolve: ' + JSON.stringify(found))
}

console.log('smoke-logon ok')
process.exit(0)
