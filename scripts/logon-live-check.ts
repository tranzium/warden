// Live check for the service Log On path (lookup + `nssm set <svc> ObjectName ...`).
// Creates a throwaway local account and NSSM service, proves tricky passwords reach
// Windows intact by starting the service under the account, then removes both.
// Dry-run by default; pass --live from an elevated prompt. See docs/logon-live-check.md.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export {} // dynamic imports below don't mark this as a module on their own

process.env.COOKIE_SECRET ??= '0123456789abcdef0123456789abcdef'
process.env.AUTH_PASSWORD_HASH ??= await Bun.password.hash('logon-live-check')

const ACCOUNT = 'warden-logon-test'
const SERVICE = 'warden-logon-test'
const ACCOUNT_REF = `.\\${ACCOUNT}`
const PROGRAM = 'C:\\Windows\\System32\\PING.EXE'
const PROGRAM_ARGS = '-n 3600 127.0.0.1'
const PASSWORDS = ['Pa ss w0rd!', 'Qu"ote1x', 'Back\\slash1\\', 'Pct%Path%9', 'Car^et&Amp1']
const WRONG_PASSWORD = 'Wr0ng-Pass!'

const STEPS = [
	`Refuse unless elevated; refuse if account or service "${ACCOUNT}" already exists`,
	`Create local account ${ACCOUNT_REF} and NSSM service ${SERVICE} (${PROGRAM} ${PROGRAM_ARGS}, manual start)`,
	`For ${PASSWORDS.length} tricky passwords: set on account, apply via Warden's Log On code, start + stop the service`,
	'Reject ./ account form before NSSM is called; wrong password applies but the service fails to start',
	'Check NSSM granted "Log on as a service" (secedit export, read only)',
	'Switch the service back to LocalSystem',
	'Cleanup: remove service, user profile, account; report the leftover logon-right SID (not removed)',
]

if (!process.argv.includes('--live')) {
	console.log('logon-live-check: DRY RUN (no changes). Pass --live from an elevated prompt to run:')
	STEPS.forEach((s, i) => console.log(`  ${i + 1}. ${s}`))
	process.exit(0)
}

const L = await import('../src/nssm/logon')
const N = await import('../src/nssm/client')

type Result = { ok: boolean; output: string }
const outputs: string[] = [] // every NSSM / Warden message, scanned for passwords at the end
const results: Array<{ name: string; pass: boolean; detail: string }> = []

function check(name: string, pass: boolean, detail = ''): boolean {
	results.push({ name, pass, detail })
	console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
	return pass
}

function keep(r: Result): Result {
	outputs.push(r.output)
	return r
}

// Values reach PowerShell through env vars only, never interpolated into the script
async function ps(script: string, env: Record<string, string> = {}): Promise<{ code: number; out: string }> {
	const proc = Bun.spawn(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script], {
		env: { ...process.env, ...env },
		stdout: 'pipe',
		stderr: 'pipe',
	})
	const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
	const code = await proc.exited
	return { code, out: (out + err).trim() }
}

const SECURE = '(ConvertTo-SecureString $env:WL_PASSWORD -AsPlainText -Force)'

async function setAccountPassword(password: string): Promise<boolean> {
	const r = await ps(`Set-LocalUser -Name $env:WL_ACCOUNT -Password ${SECURE}`, { WL_ACCOUNT: ACCOUNT, WL_PASSWORD: password })
	return r.code === 0
}

function sameRef(objectName: string | null): boolean {
	const v = (objectName ?? '').toLowerCase()
	return v === ACCOUNT_REF.toLowerCase() || v === `${process.env.COMPUTERNAME}\\${ACCOUNT}`.toLowerCase()
}

async function startStop(): Promise<{ started: boolean; detail: string }> {
	const start = keep(await N.nssmStart(SERVICE))
	let state = await N.nssmStatus(SERVICE)
	for (let i = 0; i < 20 && state === 'StartPending'; i++) {
		await Bun.sleep(250)
		state = await N.nssmStatus(SERVICE)
	}
	// nssm's own "start" wait can give up and report SERVICE_START_PENDING while the service
	// goes on to finish starting fine; trust the polled SCM status, not nssm's complaint.
	const started = state === 'Running'
	keep(await N.nssmStop(SERVICE))
	return { started, detail: started ? state : start.output || state }
}

async function exists(): Promise<{ account: boolean; service: boolean }> {
	const account = (await ps('Get-LocalUser -Name $env:WL_ACCOUNT -ErrorAction Stop | Out-Null', { WL_ACCOUNT: ACCOUNT })).code === 0
	const service = (await N.nssmList()).some(n => n.toLowerCase() === SERVICE)
	return { account, service }
}

const elevated = (await ps('([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)')).out === 'True'
if (!elevated) {
	console.log('logon-live-check: refusing --live: not elevated (run from an administrator prompt)')
	process.exit(1)
}
const before = await exists()
if (before.account || before.service) {
	console.log(`logon-live-check: refusing --live: "${ACCOUNT}" already exists (account: ${before.account}, service: ${before.service}); remove it first`)
	process.exit(1)
}

const tmp = mkdtempSync(join(tmpdir(), 'warden-logon-live-'))
let sid = ''
let createdAccount = false
let createdService = false

try {
	// 1. Throwaway account + service
	const made = await ps(
		`New-LocalUser -Name $env:WL_ACCOUNT -Password ${SECURE} -PasswordNeverExpires -AccountNeverExpires -Description 'Warden logon live check (temporary)' | Out-Null; (Get-LocalUser -Name $env:WL_ACCOUNT).SID.Value`,
		{ WL_ACCOUNT: ACCOUNT, WL_PASSWORD: PASSWORDS[0]! },
	)
	createdAccount = made.code === 0
	sid = createdAccount ? made.out.split(/\r?\n/).pop()!.trim() : ''
	if (!check('create account', createdAccount, sid || made.out)) throw new Error('setup failed')

	createdService = keep(await N.nssmInstall(SERVICE, PROGRAM)).ok
	if (!check('install service', createdService)) throw new Error('setup failed')
	keep(await N.nssmSet(SERVICE, 'AppParameters', PROGRAM_ARGS))
	keep(await N.nssmSet(SERVICE, 'Start', 'SERVICE_DEMAND_START'))

	// 2. Lookup
	check('lookup .\\account resolves', !!(await L.lookupAccount(ACCOUNT_REF)))

	// 3. Tricky passwords through Warden's real path
	for (const [i, pw] of PASSWORDS.entries()) {
		const label = `password #${i + 1}`
		if (!check(`${label}: set on account`, await setAccountPassword(pw))) continue
		const plan = L.planLogon(await N.nssmGet(SERVICE, 'ObjectName'), { kind: 'user', account: ACCOUNT_REF, password: pw, confirm: pw })
		if (!check(`${label}: planLogon -> set`, plan.action === 'set', plan.action)) continue
		const applied = keep(await L.applyLogon(SERVICE, plan as Extract<typeof plan, { action: 'set' }>))
		check(`${label}: applyLogon ok`, applied.ok, applied.output)
		check(`${label}: ObjectName is ${ACCOUNT_REF}`, sameRef(await N.nssmGet(SERVICE, 'ObjectName')))
		const run = await startStop()
		check(`${label}: service starts under account`, run.started, run.detail)
	}

	// 4. Negative cases
	const beforeSlash = await N.nssmGet(SERVICE, 'ObjectName')
	const slash = keep(await L.applyLogon(SERVICE, { action: 'set', account: `./${ACCOUNT}`, password: 'x' }))
	check('./ form rejected with suggestion', !slash.ok && slash.output === L.accountNotFound(`./${ACCOUNT}`), slash.output)
	check('./ form left ObjectName unchanged', (await N.nssmGet(SERVICE, 'ObjectName')) === beforeSlash)

	await setAccountPassword(PASSWORDS[0]!)
	const wrong = keep(await L.applyLogon(SERVICE, { action: 'set', account: ACCOUNT_REF, password: WRONG_PASSWORD }))
	check('wrong password: nssm accepts it (no validation)', wrong.ok, wrong.output)
	const wrongRun = await startStop()
	check('wrong password: service fails to start', !wrongRun.started, wrongRun.detail)

	// 5. Log on as a service (read only)
	const inf = join(tmp, 'rights.inf')
	const exported = await ps('secedit /export /areas USER_RIGHTS /cfg $env:WL_INF', { WL_INF: inf })
	let rights = ''
	let readError = ''
	try {
		rights = readFileSync(inf, 'utf16le')
	} catch (e) {
		readError = (e as Error).message
	}
	const line = rights.split(/\r?\n/).find(l => l.startsWith('SeServiceLogonRight')) ?? ''
	// secedit renders each holder by name when the account still resolves, falling back to
	// "*SID" only once the account is gone (e.g. an orphaned leftover grant) - accept either.
	const holders = line.slice(line.indexOf('=') + 1).split(',').map(h => h.trim())
	const rightsOk = !!sid && holders.some(h => h === `*${sid}` || h.toLowerCase() === ACCOUNT.toLowerCase())
	if (!rightsOk) console.log(`  diag: secedit exit=${exported.code}, read error=${readError || 'none'}, line=${JSON.stringify(line)}`)
	check('"Log on as a service" granted by NSSM', rightsOk)

	// 6. Back to LocalSystem
	const back = L.planLogon(await N.nssmGet(SERVICE, 'ObjectName'), { kind: 'system', account: '', password: '', confirm: '' })
	if (back.action === 'set') keep(await L.applyLogon(SERVICE, back))
	check('switch back to LocalSystem', L.isLocalSystem(await N.nssmGet(SERVICE, 'ObjectName')))
} catch (e) {
	console.log(`aborted: ${(e as Error).message}`)
} finally {
	// 7. Cleanup: each step independent and reported
	if (createdService) {
		await N.nssmStop(SERVICE)
		check('cleanup: remove service', (await N.nssmRemove(SERVICE)).ok)
	}
	if (sid) {
		let prof = { code: 1, out: '' }
		// WSearch/WinDefend/SysMain commonly hold the hive open past a short window; widened
		// to 30s total rather than pretending a fixed short wait is always enough.
		for (let i = 0; i < 60; i++) {
			prof = await ps('Get-CimInstance Win32_UserProfile | Where-Object SID -eq $env:WL_SID | Remove-CimInstance', { WL_SID: sid })
			if (prof.code === 0) break
			await Bun.sleep(500)
		}
		check('cleanup: remove user profile (if any)', prof.code === 0, prof.out)
	}
	if (createdAccount) {
		check('cleanup: delete account', (await ps('Remove-LocalUser -Name $env:WL_ACCOUNT', { WL_ACCOUNT: ACCOUNT })).code === 0)
	}
	rmSync(tmp, { recursive: true, force: true })
	if (sid) console.log(`NOTE  leftover "Log on as a service" entry for orphaned SID ${sid} (harmless; remove via secpol.msc > User Rights Assignment if wanted)`)
}

// Passwords must never surface in any NSSM / Warden output
const leaked = [...PASSWORDS, WRONG_PASSWORD].filter(pw => outputs.some(o => o.includes(pw)))
check('no password in any NSSM / Warden output', leaked.length === 0, leaked.length ? `${leaked.length} leaked` : '')

const failed = results.filter(r => !r.pass).length
console.log(`\nlogon-live-check: ${results.length - failed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`)
process.exit(failed ? 1 : 0)
