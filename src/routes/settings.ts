import { type AuthContext, hasPermission } from '../auth/middleware'
import { nssmGet, nssmSet, nssmList, nssmRestart, isSelf } from '../nssm/client'
import { accountNotFound, applyLogon, lookupAccount, parseLogonForm, planLogon } from '../nssm/logon'
import { redirect, forbidden, ok } from '../shared/http'
import { html403, html404 } from '../views/html'
import { settingsPage, type ServiceConfig } from '../views/settings'

// NSSM parameters surfaced on the settings page, in a stable order
const PARAMS = [
	'Application',
	'AppParameters',
	'AppDirectory',
	'Start',
	'AppStdout',
	'AppStderr',
	'AppRestartDelay',
	'AppRotateFiles',
	'AppRotateBytes',
] as const

const START_TO_MODE: Record<string, string> = {
	SERVICE_AUTO_START: 'auto',
	SERVICE_DELAYED_AUTO_START: 'delayed',
	SERVICE_DEMAND_START: 'manual',
	SERVICE_DISABLED: 'disabled',
}
const MODE_TO_START: Record<string, string> = {
	auto: 'SERVICE_AUTO_START',
	delayed: 'SERVICE_DELAYED_AUTO_START',
	manual: 'SERVICE_DEMAND_START',
	disabled: 'SERVICE_DISABLED',
}

async function resolveService(name: string): Promise<string | null> {
	const nssmNames = await nssmList()
	return nssmNames.find(n => n.toLowerCase() === name.toLowerCase()) ?? null
}

async function readRaw(name: string): Promise<Record<string, string>> {
	const values = await Promise.all(PARAMS.map(p => nssmGet(name, p)))
	const out: Record<string, string> = {}
	PARAMS.forEach((p, i) => {
		out[p] = values[i] ?? ''
	})
	return out
}

function toConfig(raw: Record<string, string>): ServiceConfig {
	return {
		program: raw.Application ?? '',
		args: raw.AppParameters ?? '',
		directory: raw.AppDirectory ?? '',
		start: START_TO_MODE[raw.Start ?? ''] ?? 'auto',
		stdout: raw.AppStdout ?? '',
		stderr: raw.AppStderr ?? '',
		restartDelay: raw.AppRestartDelay ?? '',
		rotate: raw.AppRotateFiles === '1',
		rotateBytes: raw.AppRotateBytes ?? '',
	}
}

export async function settingsPageHandler(ctx: AuthContext, name: string, req: Request): Promise<Response> {
	if (!hasPermission(ctx, 'services.install')) return html403('You do not have permission to edit service settings')

	const actual = await resolveService(name)
	if (!actual) return html404()

	// ObjectName is read on its own, not via PARAMS, so the settings save diff never touches it
	const [raw, logon] = await Promise.all([readRaw(actual), nssmGet(actual, 'ObjectName')])
	const cfg = toConfig(raw)
	const url = new URL(req.url)
	const flash = {
		saved: url.searchParams.get('saved') === '1',
		error: url.searchParams.get('error') ?? undefined,
	}

	return settingsPage(actual, cfg, logon, isSelf(actual), flash, { userName: ctx.user.email, grants: ctx.grants })
}

export async function settingsSaveHandler(ctx: AuthContext, name: string, req: Request): Promise<Response> {
	if (!hasPermission(ctx, 'services.install')) return forbidden()

	const actual = await resolveService(name)
	if (!actual) return html404()

	const back = `/services/${encodeURIComponent(actual)}/settings`
	const fail = (msg: string) => redirect(`${back}?error=${encodeURIComponent(msg)}`)

	let form: FormData
	try {
		form = await req.formData()
	} catch {
		return fail('Invalid form submission')
	}

	const get = (key: string): string => {
		const v = form.get(key)
		return typeof v === 'string' ? v.trim() : ''
	}

	const program = get('program')
	if (!program) return fail('Program is required')
	if (!(await Bun.file(program).exists())) return fail(`Program not found: ${program}`)

	const startMode = MODE_TO_START[get('start')]
	if (!startMode) return fail('Invalid startup type')

	const restartDelay = get('restartDelay')
	if (restartDelay && !/^\d+$/.test(restartDelay)) return fail('Restart delay must be a whole number of milliseconds')
	const rotateBytes = get('rotateBytes')
	if (rotateBytes && !/^\d+$/.test(rotateBytes)) return fail('Rotate size must be a whole number of bytes')

	// Log On (ObjectName): only when the card posted fields; never for warden itself.
	// Planned before anything is applied so a Log On error leaves the service untouched.
	const logonForm = parseLogonForm(form)
	if (logonForm && isSelf(actual)) return fail('Log On cannot be changed for Warden itself')
	const logonPlan = logonForm ? planLogon(await nssmGet(actual, 'ObjectName'), logonForm) : null
	if (logonPlan?.action === 'error') return fail(logonPlan.message)

	const desired: Array<[string, string]> = [
		['Application', program],
		['AppParameters', get('args')],
		['AppDirectory', get('directory')],
		['Start', startMode],
		['AppStdout', get('stdout')],
		['AppStderr', get('stderr')],
		['AppRestartDelay', restartDelay || '0'],
		['AppRotateFiles', form.get('rotate') !== null ? '1' : '0'],
		['AppRotateBytes', rotateBytes || '0'],
	]

	// Diff against the live config and set only what changed
	const current = await readRaw(actual)
	for (const [param, value] of desired) {
		if ((current[param] ?? '') === value) continue
		const result = await nssmSet(actual, param, value)
		if (!result.ok) return fail(`Failed to set ${param}: ${result.output || 'unknown error'}`)
	}

	// The password reaches nssm only via applyLogon, whose output is scrubbed
	if (logonPlan?.action === 'set') {
		const result = await applyLogon(actual, logonPlan)
		if (!result.ok) return fail(`Failed to set Log On: ${result.output || 'unknown error'}`)
	}

	// Optional immediate restart — never for warden itself (would drop this response)
	if (form.get('restart') !== null && !isSelf(actual)) {
		await nssmRestart(actual)
	}

	return redirect(`${back}?saved=1`)
}

// Account check for the Log on card's Check button / blur. Read-only, no password involved.
export async function logonLookupHandler(ctx: AuthContext, req: Request): Promise<Response> {
	if (!hasPermission(ctx, 'services.install')) return forbidden()

	const account = (new URL(req.url).searchParams.get('account') ?? '').trim()
	const resolved = await lookupAccount(account)
	return resolved ? ok({ resolved }) : ok({ resolved: null, message: accountNotFound(account) })
}
