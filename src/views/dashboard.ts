import { page, esc, type PageOpts } from './html'
import type { ServiceState } from '../nssm/client'
import { config } from '../shared/config'

export interface ServiceView {
	name: string
	display: string | null
	description: string | null
	group_name: string | null
	managed: boolean
	hidden: boolean
	missing: boolean
	status: ServiceState
}

export interface PulseData {
	total: number
	running: number
	stopped: number
	other: number
}

function statusLabel(svc: ServiceView): string {
	return svc.missing ? 'Missing' : svc.status
}

function statusBadgeClass(svc: ServiceView): string {
	if (svc.missing) return 'bg-secondary'
	switch (svc.status) {
		case 'Running':
			return 'bg-success'
		case 'Stopped':
		case 'Unknown':
			return 'bg-danger'
		case 'Paused':
			return 'bg-warning text-dark'
		default:
			return 'bg-secondary'
	}
}

function tileClass(svc: ServiceView): string {
	if (svc.missing) return 'border-secondary'
	switch (svc.status) {
		case 'Stopped':
		case 'Unknown':
			return 'border-danger'
		case 'Paused':
			return 'border-warning'
		default:
			return ''
	}
}

function isPending(status: ServiceState): boolean {
	return status.endsWith('Pending')
}

function pendingLabel(status: ServiceState): string {
	switch (status) {
		case 'StartPending':
			return 'Starting…'
		case 'StopPending':
			return 'Stopping…'
		case 'ContinuePending':
			return 'Resuming…'
		case 'PausePending':
			return 'Pausing…'
		default:
			return 'Working…'
	}
}

// Logs and Settings open in a new tab so the dashboard always stays open.
function renderLogsLink(svc: ServiceView, grants: Record<string, boolean>): string {
	if (!grants['services.logs'] || svc.missing) return ''
	return `<a class="btn btn-sm btn-outline-secondary" href="/services/${encodeURIComponent(svc.name)}/logs" target="_blank" rel="noopener" title="View logs for ${esc(svc.display ?? svc.name)}">Logs</a>`
}

function renderDetailsMenuItems(svc: ServiceView, grants: Record<string, boolean>): string[] {
	const items: string[] = []

	if (grants['services.install'] && !svc.missing) {
		items.push(`<li><a class="dropdown-item" href="/services/${encodeURIComponent(svc.name)}/settings" target="_blank" rel="noopener">Settings</a></li>`)
	}

	if (grants['services.register']) {
		items.push(`<li><a class="dropdown-item edit-btn" href="#"
			data-service="${esc(svc.name)}"
			data-display="${esc(svc.display ?? '')}"
			data-description="${esc(svc.description ?? '')}"
			data-group="${esc(svc.group_name ?? '')}"
			data-managed="${svc.managed ? '1' : '0'}">Edit</a></li>`)
		items.push(`<li><a class="dropdown-item toggle-hidden-btn" href="#"
			data-service="${esc(svc.name)}"
			data-hidden="${svc.hidden ? '1' : '0'}">${svc.hidden ? 'Show' : 'Hide'}</a></li>`)
	}

	// Destructive items sit together behind a single divider
	const danger: string[] = []
	if (grants['services.register'] && svc.missing) {
		danger.push(`<li><a class="dropdown-item text-danger delete-btn" href="#"
			data-service="${esc(svc.name)}"
			data-display="${esc(svc.display ?? svc.name)}"
			data-confirm="Remove the entry for ${esc(svc.display ?? svc.name)}? Its saved group and settings will be forgotten.">Remove entry</a></li>`)
	}
	if (grants['services.install'] && !svc.missing && svc.name !== config.wardenServiceName) {
		danger.push(`<li><a class="dropdown-item text-danger uninstall-btn" href="#"
			data-service="${esc(svc.name)}"
			data-display="${esc(svc.display ?? svc.name)}">Uninstall</a></li>`)
	}
	if (danger.length > 0) {
		if (items.length > 0) items.push('<li><hr class="dropdown-divider"></li>')
		items.push(...danger)
	}

	return items
}

// One "details" unit per tile: Logs plus an attached caret dropdown holding
// Settings/Edit/Hide/Uninstall. Static across polls — patchTile never touches it.
function renderDetailsCluster(svc: ServiceView, grants: Record<string, boolean>): string {
	const logs = renderLogsLink(svc, grants)
	const items = renderDetailsMenuItems(svc, grants)
	if (items.length === 0) return logs
	const toggle = `<button class="btn btn-sm btn-outline-secondary dropdown-toggle${logs ? ' dropdown-toggle-split' : ''}" type="button" data-bs-toggle="dropdown" aria-expanded="false"><span class="visually-hidden">More actions</span></button>`
	return `<div class="btn-group">${logs}${toggle}<ul class="dropdown-menu dropdown-menu-end">${items.join('')}</ul></div>`
}

function renderActionButtons(svc: ServiceView, grants: Record<string, boolean>): string {
	if (svc.missing || !svc.managed) return ''

	if (isPending(svc.status)) {
		return `<div class="btn-group"><button class="btn btn-outline-secondary btn-sm" type="button" disabled>${esc(pendingLabel(svc.status))}</button></div>`
	}

	const isSelf = svc.name === config.wardenServiceName
	const buttons: string[] = []

	if (svc.status === 'Stopped' || svc.status === 'Paused' || svc.status === 'Unknown') {
		if (grants['services.start']) {
			buttons.push(
				`<button class="btn btn-outline-success btn-sm action-btn" data-action="start" data-service="${esc(svc.name)}">Start</button>`,
			)
		}
	}

	if (svc.status === 'Running' || svc.status === 'Paused') {
		if (grants['services.stop'] && !isSelf) {
			buttons.push(
				`<button class="btn btn-outline-danger btn-sm action-btn" data-action="stop" data-service="${esc(svc.name)}" data-confirm="Stop ${esc(svc.display ?? svc.name)}?">Stop</button>`,
			)
		}
		if (grants['services.restart']) {
			const confirmMsg = isSelf
				? 'Restarting warden will disconnect the dashboard for ~10 seconds. Continue?'
				: `Restart ${svc.display ?? svc.name}?`
			buttons.push(
				`<button class="btn btn-outline-warning btn-sm action-btn" data-action="restart" data-service="${esc(svc.name)}" data-confirm="${esc(confirmMsg)}"${isSelf ? ' data-self="true"' : ''}>Restart</button>`,
			)
		}
	}

	if (buttons.length === 0) return ''
	return `<div class="btn-group">${buttons.join('')}</div>`
}

// Bottom row: Start/Stop controls on the left, the details cluster on the right,
// so nothing crowds the status badge in the header. Only .tile-actions is
// state-dependent; the details cluster is static per tile lifetime.
function renderTileFooter(svc: ServiceView, grants: Record<string, boolean>): string {
	const actions = renderActionButtons(svc, grants)
	const details = renderDetailsCluster(svc, grants)
	if (!actions && !details) return ''
	return `
		<div class="d-flex justify-content-between align-items-center gap-2 mt-2 tile-footer">
			<div class="tile-actions">${actions}</div>
			${details}
		</div>`
}

function renderTile(svc: ServiceView, grants: Record<string, boolean>): string {
	return `
		<div class="service-col col-xl-3 col-lg-4 col-md-6${svc.hidden ? ' svc-hidden' : ''}" data-service="${esc(svc.name)}" data-hidden="${svc.hidden ? '1' : '0'}" data-missing="${svc.missing ? '1' : '0'}">
			<div class="card service-tile shadow-sm ${tileClass(svc)}">
				<div class="card-body">
					<div class="d-flex justify-content-between align-items-start mb-1">
						<h6 class="card-title mb-0">${esc(svc.display ?? svc.name)}</h6>
						<span class="badge ${statusBadgeClass(svc)} status-badge text-uppercase">${esc(statusLabel(svc))}</span>
					</div>
					${svc.description ? `<p class="card-text text-muted small mb-0">${esc(svc.description)}</p>` : ''}
					${renderTileFooter(svc, grants)}
				</div>
			</div>
		</div>`
}

// `index` drives the alternating band so adjacent groups read as distinct
// click/collapse regions. First paint counts every rendered group; applyFilters
// in poll.js immediately reassigns over *visible* groups so filtering never
// leaves two same-colour bands adjacent.
function renderGroup(groupName: string, services: ServiceView[], grants: Record<string, boolean>, index: number): string {
	const running = services.filter(s => s.status === 'Running').length
	const total = services.length
	const allUp = running === total
	const badgeClass = allUp ? 'bg-success' : 'bg-warning text-dark'
	const allHidden = services.every(s => s.hidden)

	const collapseId = `group-${groupName.replace(/\s+/g, '-').toLowerCase()}`

	return `
		<div class="service-group mb-4 p-3 rounded-3${index % 2 === 1 ? ' bg-body-secondary' : ''}${allHidden ? ' svc-hidden' : ''}" data-group-name="${esc(groupName)}">
			<h5 class="d-flex align-items-center gap-2 mb-3 group-header user-select-none" role="button"
				data-bs-toggle="collapse" data-bs-target="#${collapseId}" aria-expanded="true">
				<span class="badge ${badgeClass} group-pulse text-center">${running}/${total}</span>
				<span>${esc(groupName)}</span>
			</h5>
			<div class="collapse show" id="${collapseId}">
				<div class="row g-3">
					${services.map(s => renderTile(s, grants)).join('')}
				</div>
			</div>
		</div>`
}

function renderToolbar(pulse: PulseData, groupNames: string[], grants: Record<string, boolean>): string {
	const parts: string[] = []
	if (pulse.running > 0) parts.push(`<span class="badge bg-success">${pulse.running} running</span>`)
	if (pulse.stopped > 0) parts.push(`<span class="badge bg-danger">${pulse.stopped} stopped</span>`)
	if (pulse.other > 0) parts.push(`<span class="badge bg-secondary">${pulse.other} other</span>`)

	const groupOptions = groupNames.map(g => `<option value="${esc(g)}">${esc(g)}</option>`).join('')

	const installButton = grants['services.install']
		? `<button type="button" class="btn btn-primary btn-sm" id="install-service-btn">+ Install service</button>`
		: ''

	return `<div id="pulse-bar" class="d-flex justify-content-between align-items-center gap-2 mb-3 py-2 border-bottom flex-wrap">
		<div class="d-flex gap-2" id="pulse-badges">${parts.join('')}</div>
		<div class="d-flex align-items-center gap-3">
			<select class="form-select form-select-sm w-auto" id="group-filter" aria-label="Filter by group">
				<option value="">All groups</option>
				${groupOptions}
			</select>
			<div class="form-check form-switch mb-0">
				<input class="form-check-input" type="checkbox" id="show-hidden-toggle">
				<label class="form-check-label small" for="show-hidden-toggle">Show hidden</label>
			</div>
			${installButton}
		</div>
	</div>`
}

function renderServiceModal(groups: string[]): string {
	const groupOptions = groups.map(g => `<option value="${esc(g)}">`).join('')
	return `
	<div class="modal fade" id="service-modal" tabindex="-1" aria-hidden="true">
		<div class="modal-dialog">
			<div class="modal-content">
				<form id="service-form">
					<div class="modal-header">
						<h5 class="modal-title" id="service-modal-title">Install service</h5>
						<button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
					</div>
					<div class="modal-body">
						<div class="alert alert-danger d-none" id="service-form-error"></div>
						<input type="hidden" id="svc-mode" value="install">
						<input type="hidden" id="svc-original-name" value="">
						<div class="mb-3">
							<label for="svc-name" class="form-label">Service name</label>
							<input type="text" class="form-control" id="svc-name" autocomplete="off" required>
							<div class="form-text">Letters, digits, dot, underscore and hyphen only.</div>
						</div>
						<div class="mb-3 install-only">
							<label for="svc-program" class="form-label">Program</label>
							<input type="text" class="form-control" id="svc-program" placeholder="D:\\apps\\myservice\\myservice.exe">
						</div>
						<div class="mb-3 install-only">
							<label for="svc-args" class="form-label">Arguments</label>
							<input type="text" class="form-control" id="svc-args">
						</div>
						<div class="mb-3 install-only">
							<label for="svc-directory" class="form-label">Working directory</label>
							<input type="text" class="form-control" id="svc-directory" placeholder="Defaults to the program's directory">
						</div>
						<div class="mb-3 install-only">
							<label for="svc-start" class="form-label">Startup type</label>
							<select class="form-select" id="svc-start">
								<option value="auto" selected>Automatic</option>
								<option value="delayed">Automatic (delayed)</option>
								<option value="manual">Manual</option>
								<option value="disabled">Disabled</option>
							</select>
						</div>
						<div class="mb-3 install-only">
							<label for="svc-stdout" class="form-label">Stdout log</label>
							<input type="text" class="form-control" id="svc-stdout">
						</div>
						<div class="mb-3 install-only">
							<label for="svc-stderr" class="form-label">Stderr log</label>
							<input type="text" class="form-control" id="svc-stderr">
						</div>
						<div class="mb-3">
							<label for="svc-display" class="form-label">Display name</label>
							<input type="text" class="form-control" id="svc-display">
						</div>
						<div class="mb-3">
							<label for="svc-description" class="form-label">Description</label>
							<textarea class="form-control" id="svc-description" rows="2"></textarea>
						</div>
						<div class="mb-3">
							<label for="svc-group" class="form-label">Group</label>
							<input type="text" class="form-control" id="svc-group" list="svc-groups-list">
							<datalist id="svc-groups-list">${groupOptions}</datalist>
						</div>
						<div class="form-check edit-only">
							<input type="checkbox" class="form-check-input" id="svc-managed" checked>
							<label class="form-check-label" for="svc-managed">Managed (show start/stop controls)</label>
						</div>
					</div>
					<div class="modal-footer">
						<button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button>
						<button type="submit" class="btn btn-primary" id="service-form-submit">Install</button>
					</div>
				</form>
			</div>
		</div>
	</div>`
}

export function dashboardPage(services: ServiceView[], grants: Record<string, boolean>, opts: PageOpts): Response {
	// Pulse counts cover visible services only — hidden ones are deliberately out of sight
	const visible = services.filter(s => !s.hidden)
	const pulse: PulseData = {
		total: visible.length,
		running: visible.filter(s => s.status === 'Running').length,
		stopped: visible.filter(s => s.status === 'Stopped' || s.status === 'Unknown').length,
		other: 0,
	}
	pulse.other = pulse.total - pulse.running - pulse.stopped

	// Group services
	const groups = new Map<string, ServiceView[]>()
	for (const svc of services) {
		const group = svc.group_name ?? 'Ungrouped'
		if (!groups.has(group)) groups.set(group, [])
		groups.get(group)!.push(svc)
	}

	// Sort within each group alphabetically by display name — stable across status changes,
	// so a tile doesn't jump position mid-action. Problems are still surfaced via border/badge/pulse.
	for (const [, list] of groups) {
		list.sort((a, b) => (a.display ?? a.name).toLowerCase().localeCompare((b.display ?? b.name).toLowerCase()))
	}

	const groupHtml = services.length === 0
		? `<div class="text-center text-muted mt-5">
			<h4>No services found</h4>
			<p>NSSM-managed services appear here automatically.</p>
		</div>`
		: Array.from(groups.entries())
				// Alphabetical by group name, matching the poll's client-side order —
				// otherwise groups visibly reshuffle on the first poll after page load
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([name, svcs], i) => renderGroup(name, svcs, grants, i))
				.join('')

	const wardenConfig = JSON.stringify({
		grants,
		wardenServiceName: config.wardenServiceName,
		logsDir: config.logsDir,
	})

	const canManage = grants['services.register'] || grants['services.install']
	const groupNames = Array.from(groups.keys()).sort()
	const editableGroups = Array.from(new Set(services.map(s => s.group_name).filter((g): g is string => !!g))).sort()

	const body = `
		${renderToolbar(pulse, groupNames, grants)}
		<div id="services-container">
			${groupHtml}
		</div>
		<div id="reconnect-overlay" class="d-none position-fixed top-0 start-0 w-100 h-100 bg-dark bg-opacity-75 d-flex align-items-center justify-content-center z-3">
			<div class="text-center">
				<div class="spinner-border text-light mb-3" role="status"></div>
				<h4 class="text-light">Reconnecting to Warden...</h4>
			</div>
		</div>
		<div id="toast-container" class="toast-container position-fixed bottom-0 end-0 p-3"></div>
		${canManage ? renderServiceModal(editableGroups) : ''}
		<script>window.__WARDEN__ = ${wardenConfig};</script>`

	return page('Dashboard', body, { ...opts, scripts: true })
}
