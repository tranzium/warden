import { rmSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import {
	nssmStatus,
	nssmStop,
	nssmRemove,
	nssmGet,
	servicePid,
	killProcessTree,
	type ServiceState,
} from './client'
import { config } from '../shared/config'

export interface UninstallOps {
	status(name: string): Promise<ServiceState>
	stop(name: string): Promise<{ ok: boolean; output: string }>
	pid(name: string): Promise<number | null>
	kill(pid: number): Promise<boolean>
	remove(name: string): Promise<{ ok: boolean; output: string }>
	get(name: string, parameter: string): Promise<string | null>
	removeDir(path: string): void
	sleep(ms: number): Promise<void>
}

export const defaultOps: UninstallOps = {
	status: nssmStatus,
	stop: nssmStop,
	pid: servicePid,
	kill: killProcessTree,
	remove: nssmRemove,
	get: nssmGet,
	removeDir: path => rmSync(path, { recursive: true, force: true }),
	sleep: ms => new Promise(r => setTimeout(r, ms)),
}

export interface UninstallTimings {
	gracefulMs: number
	forceMs: number
	pollMs: number
}

export const defaultTimings: UninstallTimings = { gracefulMs: 20_000, forceMs: 10_000, pollMs: 500 }

export type UninstallOutcome =
	| { ok: true; service: string; stopped: 'already-stopped' | 'graceful' | 'forced'; cleaned: string[] }
	| { ok: false; error: string }

async function waitStopped(name: string, ops: UninstallOps, budgetMs: number, pollMs: number): Promise<boolean> {
	for (let waited = 0; ; waited += pollMs) {
		if ((await ops.status(name)) === 'Stopped') return true
		if (waited >= budgetMs) return false
		await ops.sleep(pollMs)
	}
}

// Log dir the service owns: <logsDir>/<name>, but only when both configured log files live inside it
async function ownedLogDir(name: string, ops: UninstallOps): Promise<string | null> {
	const dir = resolve(config.logsDir, name)
	if (relative(resolve(config.logsDir), dir).startsWith('..') || dir === resolve(config.logsDir)) return null
	let configured = 0
	for (const param of ['AppStdout', 'AppStderr']) {
		const value = await ops.get(name, param)
		if (!value) continue
		configured++
		const rel = relative(dir.toLowerCase(), resolve(value).toLowerCase())
		if (rel.startsWith('..') || isAbsolute(rel)) return null
	}
	return configured > 0 ? dir : null
}

// Stop (graceful, then force) -> refuse unless confirmed Stopped -> remove registration -> clean artifacts.
// Nothing destructive runs while the process may still be live.
export async function uninstallService(
	name: string,
	ops: UninstallOps = defaultOps,
	timings: UninstallTimings = defaultTimings,
): Promise<UninstallOutcome> {
	let stopped: 'already-stopped' | 'graceful' | 'forced' = 'already-stopped'

	if ((await ops.status(name)) !== 'Stopped') {
		await ops.stop(name)
		if (await waitStopped(name, ops, timings.gracefulMs, timings.pollMs)) {
			stopped = 'graceful'
		} else {
			const pid = await ops.pid(name)
			if (pid !== null) await ops.kill(pid)
			if (!(await waitStopped(name, ops, timings.forceMs, timings.pollMs))) {
				return { ok: false, error: `Uninstall refused: '${name}' is still running after a graceful stop and a force kill. Nothing was removed.` }
			}
			stopped = 'forced'
		}
	}

	// Read before remove: the settings vanish with the registration
	const logDir = await ownedLogDir(name, ops)

	const removed = await ops.remove(name)
	if (!removed.ok) return { ok: false, error: `Uninstall failed: ${removed.output}` }

	const cleaned: string[] = []
	if (logDir) {
		try {
			ops.removeDir(logDir)
			cleaned.push(logDir)
		} catch {
			// best effort — the service is already gone; a locked log file must not fail the uninstall
		}
	}
	return { ok: true, service: name, stopped, cleaned }
}
