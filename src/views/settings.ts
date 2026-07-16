import { page, esc, type PageOpts } from './html'

export interface ServiceConfig {
	program: string
	args: string
	directory: string
	start: string // auto | delayed | manual | disabled
	stdout: string
	stderr: string
	restartDelay: string
	rotate: boolean
	rotateBytes: string
}

const START_OPTIONS: Array<[string, string]> = [
	['auto', 'Automatic'],
	['delayed', 'Automatic (delayed)'],
	['manual', 'Manual'],
	['disabled', 'Disabled'],
]

// Shared by the settings page today and a future /services/install page — keeping
// the field markup (labels, placeholders, hints) in one renderer stops the two
// forms drifting apart as fields evolve.
export function configFieldSections(cfg: ServiceConfig): string {
	const startOptions = START_OPTIONS.map(
		([v, label]) => `<option value="${v}"${cfg.start === v ? ' selected' : ''}>${label}</option>`,
	).join('')

	return `
		<div class="card mb-3">
			<div class="card-header">Application</div>
			<div class="card-body">
				<div class="mb-3">
					<label for="program" class="form-label">Program</label>
					<input type="text" class="form-control" id="program" name="program" value="${esc(cfg.program)}" placeholder="D:\\apps\\myservice\\myservice.exe" required>
				</div>
				<div class="mb-3">
					<label for="args" class="form-label">Arguments</label>
					<input type="text" class="form-control" id="args" name="args" value="${esc(cfg.args)}">
				</div>
				<div class="mb-0">
					<label for="directory" class="form-label">Working directory</label>
					<input type="text" class="form-control" id="directory" name="directory" value="${esc(cfg.directory)}" placeholder="Defaults to the program's directory">
				</div>
			</div>
		</div>
		<div class="card mb-3">
			<div class="card-header">Startup</div>
			<div class="card-body">
				<div class="mb-3">
					<label for="start" class="form-label">Startup type</label>
					<select class="form-select" id="start" name="start">${startOptions}</select>
				</div>
				<div class="mb-0">
					<label for="restartDelay" class="form-label">Restart delay (ms)</label>
					<input type="number" min="0" class="form-control" id="restartDelay" name="restartDelay" value="${esc(cfg.restartDelay)}">
					<div class="form-text">How long NSSM waits before restarting the application after it exits.</div>
				</div>
			</div>
		</div>
		<div class="card mb-3">
			<div class="card-header">Logging &amp; rotation</div>
			<div class="card-body">
				<div class="mb-3">
					<label for="stdout" class="form-label">Stdout log</label>
					<input type="text" class="form-control" id="stdout" name="stdout" value="${esc(cfg.stdout)}">
				</div>
				<div class="mb-3">
					<label for="stderr" class="form-label">Stderr log</label>
					<input type="text" class="form-control" id="stderr" name="stderr" value="${esc(cfg.stderr)}">
				</div>
				<div class="form-check form-switch mb-3">
					<input class="form-check-input" type="checkbox" id="rotate" name="rotate"${cfg.rotate ? ' checked' : ''}>
					<label class="form-check-label" for="rotate">Rotate log files</label>
				</div>
				<div class="mb-0">
					<label for="rotateBytes" class="form-label">Rotate at size (bytes)</label>
					<input type="number" min="0" class="form-control" id="rotateBytes" name="rotateBytes" value="${esc(cfg.rotateBytes)}">
				</div>
			</div>
		</div>`
}

export function settingsPage(
	name: string,
	cfg: ServiceConfig,
	isSelf: boolean,
	flash: { saved?: boolean; error?: string },
	opts: PageOpts,
): Response {
	const alert = flash.saved
		? `<div class="alert alert-success">Settings saved. Changes take effect the next time the service restarts.</div>`
		: flash.error
			? `<div class="alert alert-danger">${esc(flash.error)}</div>`
			: ''

	const selfWarning = isSelf
		? `<div class="alert alert-warning">This is Warden itself. Changing the program, arguments or startup type can prevent the dashboard from starting again. Edit with care.</div>`
		: ''

	// Never offered for warden itself — restarting would drop the dashboard mid-save.
	const restartField = isSelf
		? ''
		: `<div class="form-check form-switch mb-0">
				<input class="form-check-input" type="checkbox" id="restart" name="restart">
				<label class="form-check-label" for="restart">Restart the service now to apply changes</label>
			</div>`

	// The apply-on-restart notice and the restart-now switch are one concept, so they
	// share a muted box directly above Save — read just before committing changes.
	const noticeBox = `
			<div class="bg-body-secondary rounded-3 p-3 mb-3">
				<div class="small text-muted${isSelf ? '' : ' mb-2'}">NSSM reads a service's configuration when it starts. Saved changes apply the next time the service restarts.</div>
				${restartField}
			</div>`

	const body = `
		<div class="col-lg-7 col-xl-6 mx-auto">
			<div class="d-flex justify-content-between align-items-center mb-3 flex-wrap gap-2">
				<h4 class="mb-0">${esc(name)} &mdash; Settings</h4>
				<a class="btn btn-sm btn-outline-secondary" href="/services/${encodeURIComponent(name)}/logs">Logs</a>
			</div>
			${alert}
			${selfWarning}
			<div class="bg-body-tertiary rounded-3 p-3 p-lg-4">
				<form method="POST" action="/services/${encodeURIComponent(name)}/settings">
					${configFieldSections(cfg)}
					${noticeBox}
					<button type="submit" class="btn btn-primary">Save changes</button>
				</form>
			</div>
		</div>`

	return page(`Settings — ${name}`, body, opts)
}
