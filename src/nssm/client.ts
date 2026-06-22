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

async function nssm(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn([config.nssmPath, ...args], {
		stdout: 'pipe',
		stderr: 'pipe',
	})
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	])
	const exitCode = await proc.exited
	return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() }
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

export function isSelf(serviceName: string): boolean {
	return serviceName === config.wardenServiceName
}

export function selfRestart(): void {
	setTimeout(() => process.exit(0), 500)
}
