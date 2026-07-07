import { config } from '../shared/config'

export type ServiceState =
	| 'Running'
	| 'Stopped'
	| 'Paused'
	| 'StartPending'
	| 'StopPending'
	| 'ContinuePending'
	| 'PausePending'
	| 'Unknown'

const STATE_MAP: Record<string, ServiceState> = {
	SERVICE_RUNNING: 'Running',
	SERVICE_STOPPED: 'Stopped',
	SERVICE_PAUSED: 'Paused',
	SERVICE_START_PENDING: 'StartPending',
	SERVICE_STOP_PENDING: 'StopPending',
	SERVICE_CONTINUE_PENDING: 'ContinuePending',
	SERVICE_PAUSE_PENDING: 'PausePending',
}

const SC_STATE_MAP: Record<string, ServiceState> = {
	RUNNING: 'Running',
	STOPPED: 'Stopped',
	PAUSED: 'Paused',
	START_PENDING: 'StartPending',
	STOP_PENDING: 'StopPending',
	CONTINUE_PENDING: 'ContinuePending',
	PAUSE_PENDING: 'PausePending',
}

// NSSM >= 2.24 emits UTF-16LE on piped stdout/stderr
function decodeOutput(buf: ArrayBuffer): string {
	const bytes = new Uint8Array(buf)
	const utf16 = bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || bytes.includes(0))
	let text = utf16 ? new TextDecoder('utf-16le').decode(buf) : new TextDecoder().decode(buf)
	if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
	return text
}

async function nssm(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn([config.nssmPath, ...args], {
		stdout: 'pipe',
		stderr: 'pipe',
	})
	const [out, err] = await Promise.all([
		new Response(proc.stdout).arrayBuffer(),
		new Response(proc.stderr).arrayBuffer(),
	])
	const exitCode = await proc.exited
	return { exitCode, stdout: decodeOutput(out).trim(), stderr: decodeOutput(err).trim() }
}

export async function nssmStatus(name: string): Promise<ServiceState> {
	try {
		const { stdout } = await nssm(['status', name])
		return STATE_MAP[stdout] ?? 'Unknown'
	} catch {
		return 'Unknown'
	}
}

export async function nssmStart(name: string): Promise<{ ok: boolean; output: string }> {
	const { exitCode, stdout, stderr } = await nssm(['start', name])
	return { ok: exitCode === 0, output: stdout || stderr }
}

export async function nssmStop(name: string): Promise<{ ok: boolean; output: string }> {
	const { exitCode, stdout, stderr } = await nssm(['stop', name])
	return { ok: exitCode === 0, output: stdout || stderr }
}

export async function nssmRestart(name: string): Promise<{ ok: boolean; output: string }> {
	const { exitCode, stdout, stderr } = await nssm(['restart', name])
	return { ok: exitCode === 0, output: stdout || stderr }
}

// Names of all NSSM-hosted services — the membership source of truth
export async function nssmList(): Promise<string[]> {
	try {
		const { exitCode, stdout } = await nssm(['list'])
		if (exitCode !== 0) return []
		return stdout
			.split(/\r?\n/)
			.map(s => s.trim())
			.filter(Boolean)
	} catch {
		return []
	}
}

export async function nssmInstall(name: string, program: string): Promise<{ ok: boolean; output: string }> {
	const { exitCode, stdout, stderr } = await nssm(['install', name, program])
	return { ok: exitCode === 0, output: stdout || stderr }
}

export async function nssmSet(name: string, parameter: string, ...values: string[]): Promise<{ ok: boolean; output: string }> {
	const { exitCode, stdout, stderr } = await nssm(['set', name, parameter, ...values])
	return { ok: exitCode === 0, output: stdout || stderr }
}

export async function nssmRemove(name: string): Promise<{ ok: boolean; output: string }> {
	const { exitCode, stdout, stderr } = await nssm(['remove', name, 'confirm'])
	return { ok: exitCode === 0, output: stdout || stderr }
}

export interface WindowsService {
	name: string
	display: string
	state: ServiceState
}

// One spawn returns name + display name + state for every service on the box
export async function listWindowsServices(): Promise<WindowsService[]> {
	try {
		const proc = Bun.spawn(['sc', 'query', 'state=', 'all'], {
			stdout: 'pipe',
			stderr: 'pipe',
		})
		const stdout = await new Response(proc.stdout).text()
		await proc.exited

		const services: WindowsService[] = []
		let current: WindowsService | null = null
		for (const line of stdout.split('\n')) {
			const nameMatch = line.match(/^SERVICE_NAME:\s*(.+?)\s*\r?$/)
			if (nameMatch) {
				current = { name: nameMatch[1]!, display: nameMatch[1]!, state: 'Unknown' }
				services.push(current)
				continue
			}
			if (!current) continue
			const displayMatch = line.match(/^DISPLAY_NAME:\s*(.+?)\s*\r?$/)
			if (displayMatch) {
				current.display = displayMatch[1]!
				continue
			}
			const stateMatch = line.match(/^\s+STATE\s*:\s*\d+\s+(\w+)/)
			if (stateMatch) current.state = SC_STATE_MAP[stateMatch[1]!] ?? 'Unknown'
		}
		services.sort((a, b) => a.name.localeCompare(b.name))
		return services
	} catch {
		return []
	}
}

export function isSelf(serviceName: string): boolean {
	return serviceName === config.wardenServiceName
}

export function selfRestart(): void {
	setTimeout(() => process.exit(0), 500)
}
