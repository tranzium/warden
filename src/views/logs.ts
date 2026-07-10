import { page, esc, type PageOpts } from './html'

export function logsPage(name: string, opts: PageOpts): Response {
	const body = `
		<div class="d-flex justify-content-between align-items-start mb-3 flex-wrap gap-2">
			<div>
				<a href="/" class="small d-block mb-1">&larr; Back to dashboard</a>
				<h4 class="mb-0">${esc(name)} &mdash; Logs</h4>
			</div>
			<div class="d-flex align-items-center gap-2 flex-wrap">
				<div class="btn-group btn-group-sm" role="group" id="stream-tabs">
					<button type="button" class="btn btn-outline-secondary active" data-stream="stdout">stdout</button>
					<button type="button" class="btn btn-outline-secondary" data-stream="stderr">stderr</button>
				</div>
				<select class="form-select form-select-sm w-auto" id="file-select" aria-label="Log file">
					<option value="">Current</option>
				</select>
				<div class="form-check form-switch mb-0">
					<input class="form-check-input" type="checkbox" id="follow-toggle" checked>
					<label class="form-check-label small" for="follow-toggle">Follow</label>
				</div>
			</div>
		</div>
		<div id="logs-status" class="small text-muted mb-2">Loading&hellip;</div>
		<pre id="logs-pane" class="logs-pane"></pre>
		<script>window.__WARDEN_LOGS__ = ${JSON.stringify({ service: name })};</script>`

	return page(`Logs — ${name}`, body, { ...opts, scripts: true, script: '/static/js/logs.js' })
}
