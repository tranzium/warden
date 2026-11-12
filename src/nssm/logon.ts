import { nssmSet } from './client'

// Service Log On (NSSM `ObjectName`): pure decision logic plus two thin side effects -
// account lookup (PowerShell) and apply (`nssm set <svc> ObjectName ...`).

export const LOCAL_SYSTEM = 'LocalSystem'
export const SCRUBBED = '********'

export type LogonKind = 'system' | 'user'

export interface LogonForm {
	kind: LogonKind
	account: string
	password: string
	confirm: string
}

export type LogonSet = { action: 'set'; account: string; password: string | null }
export type LogonPlan = { action: 'none' } | LogonSet | { action: 'error'; message: string }

// NSSM's default is LocalSystem, so an unreadable / unset value counts as LocalSystem
export function isLocalSystem(objectName: string | null): boolean {
	return !objectName || objectName.trim().toLowerCase() === LOCAL_SYSTEM.toLowerCase()
}

function sameAccount(a: string, b: string): boolean {
	return a.trim().toLowerCase() === b.trim().toLowerCase()
}

// Null when the form carries no Log On fields (e.g. Warden's own read-only card)
export function parseLogonForm(form: FormData): LogonForm | null {
	const kind = form.get('logonKind')
	if (kind !== 'system' && kind !== 'user') return null
	const text = (key: string): string => {
		const v = form.get(key)
		return typeof v === 'string' ? v : ''
	}
	// Passwords are kept exactly as typed - whitespace may be part of them
	return { kind, account: text('logonAccount').trim(), password: text('logonPassword'), confirm: text('logonConfirm') }
}

export function planLogon(current: string | null, form: LogonForm): LogonPlan {
	if (form.kind === 'system') {
		return isLocalSystem(current) ? { action: 'none' } : { action: 'set', account: LOCAL_SYSTEM, password: null }
	}
	if (form.password !== form.confirm) return { action: 'error', message: 'Passwords do not match' }
	const account = form.account.trim()
	if (!account) return { action: 'error', message: 'Account is required' }
	const unchanged = !isLocalSystem(current) && sameAccount(account, current!)
	if (!form.password) {
		return unchanged ? { action: 'none' } : { action: 'error', message: 'A password is required when changing the account' }
	}
	return { action: 'set', account, password: form.password }
}

// `./name` is a common slip for the Windows local-account form `.\name`
export function backslashSuggestion(account: string): string | null {
	return account.startsWith('./') ? `.\\${account.slice(2)}` : null
}

export function accountNotFound(account: string): string {
	const suggestion = backslashSuggestion(account)
	return `Account not found: ${account}${suggestion ? ` - did you mean ${suggestion}?` : ''}`
}

export function scrubSecret(text: string, secret: string | null): string {
	return secret ? text.split(secret).join(SCRUBBED) : text
}

// The account is passed via an env var and never interpolated into the script, so
// PowerShell metacharacters in it are plain data. `.\` maps to this machine here only.
const LOOKUP_PS =
	"$n = $env:WARDEN_ACCOUNT; if ($n.StartsWith('.\\')) { $n = $env:COMPUTERNAME + $n.Substring(1) }; try { $s = ([System.Security.Principal.NTAccount]$n).Translate([System.Security.Principal.SecurityIdentifier]); $s.Translate([System.Security.Principal.NTAccount]).Value } catch { exit 1 }"

// Canonical `DOMAIN\name` for a resolvable account, else null
export async function lookupAccount(account: string): Promise<string | null> {
	if (!account.trim()) return null
	try {
		const proc = Bun.spawn(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', LOOKUP_PS], {
			env: { ...process.env, WARDEN_ACCOUNT: account },
			stdout: 'pipe',
			stderr: 'pipe',
		})
		const stdout = (await new Response(proc.stdout).text()).trim()
		return (await proc.exited) === 0 && stdout ? stdout : null
	} catch {
		return null
	}
}

export async function applyLogon(service: string, plan: LogonSet): Promise<{ ok: boolean; output: string }> {
	if (plan.account === LOCAL_SYSTEM) return nssmSet(service, 'ObjectName', LOCAL_SYSTEM)
	if (!(await lookupAccount(plan.account))) return { ok: false, output: accountNotFound(plan.account) }
	const result = await nssmSet(service, 'ObjectName', plan.account, plan.password ?? '')
	return { ok: result.ok, output: scrubSecret(result.output, plan.password) }
}
