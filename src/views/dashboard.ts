import { page, esc, type PageOpts } from './html'
import type { ServiceState } from '../nssm/client'
import { config } from '../shared/config'

export interface ServiceView {
	name: string
	display: string | null
	description: string | null
	group_name: string | null
	managed: boolean
	status: ServiceState
}

export interface PulseData {
	total: number
	running: number
	stopped: number
	other: number
}

// Sort priority: failed/stopped float to top, running sinks
const STATE_PRIORITY: Record<string, number> = {
	Unknown: 0,
	Stopped: 1,
	Paused: 2,
	StopPending: 3,
	StartPending: 4,
	ContinuePending: 5,
	PausePending: 6,
	Running: 7,
}

function statusBadgeClass(status: ServiceState): string {
	switch (status) {
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

function tileClass(status: ServiceState): string {
	switch (status) {
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

function renderActionButtons(svc: ServiceView, grants: Record<string, boolean>): string {
	if (!svc.managed || isPending(svc.status)) return ''

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
	return `<div class="btn-group mt-2">${buttons.join('')}</div>`
}

function renderTile(svc: ServiceView, grants: Record<string, boolean>): string {
	return `
		<div class="col-xl-3 col-lg-4 col-md-6" data-service="${esc(svc.name)}">
			<div class="card service-tile ${tileClass(svc.status)}">
				<div class="card-body">
					<div class="d-flex justify-content-between align-items-start mb-1">
						<h6 class="card-title mb-0">${esc(svc.display ?? svc.name)}</h6>
						<span class="badge ${statusBadgeClass(svc.status)} status-badge">${esc(svc.status)}</span>
					</div>
					${svc.description ? `<p class="card-text text-muted small mb-0">${esc(svc.description)}</p>` : ''}
					${renderActionButtons(svc, grants)}
				</div>
			</div>
		</div>`
}

function renderGroup(groupName: string, services: ServiceView[], grants: Record<string, boolean>): string {
	const running = services.filter(s => s.status === 'Running').length
	const total = services.length
	const allUp = running === total
	const badgeClass = allUp ? 'bg-success' : 'bg-warning text-dark'

	// Expand groups that have problems
	const hasProblems = services.some(s => s.status !== 'Running')
	const collapseId = `group-${groupName.replace(/\s+/g, '-').toLowerCase()}`

	return `
		<div class="service-group mb-4">
			<h5 class="d-flex align-items-center gap-2 mb-3 group-header" role="button"
				data-bs-toggle="collapse" data-bs-target="#${collapseId}" aria-expanded="${hasProblems ? 'true' : 'true'}">
				<span>${esc(groupName)}</span>
				<span class="badge ${badgeClass}">${running}/${total}</span>
			</h5>
			<div class="collapse show" id="${collapseId}">
				<div class="row g-3">
					${services.map(s => renderTile(s, grants)).join('')}
				</div>
			</div>
		</div>`
}

function renderPulseBar(pulse: PulseData): string {
	const parts: string[] = []
	if (pulse.running > 0) parts.push(`<span class="badge bg-success">${pulse.running} running</span>`)
	if (pulse.stopped > 0) parts.push(`<span class="badge bg-danger">${pulse.stopped} stopped</span>`)
	if (pulse.other > 0) parts.push(`<span class="badge bg-secondary">${pulse.other} other</span>`)
	return `<div id="pulse-bar" class="d-flex gap-2 mb-3">${parts.join('')}</div>`
}

export function dashboardPage(services: ServiceView[], grants: Record<string, boolean>, opts: PageOpts): Response {
	// Build pulse data
	const pulse: PulseData = {
		total: services.length,
		running: services.filter(s => s.status === 'Running').length,
		stopped: services.filter(s => s.status === 'Stopped' || s.status === 'Unknown').length,
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

	// Sort within each group: problems first
	for (const [, list] of groups) {
		list.sort((a, b) => (STATE_PRIORITY[a.status] ?? 99) - (STATE_PRIORITY[b.status] ?? 99))
	}

	const groupHtml = services.length === 0
		? `<div class="text-center text-muted mt-5">
			<h4>No services registered</h4>
			<p>Register services to start managing them.</p>
		</div>`
		: Array.from(groups.entries())
				.map(([name, svcs]) => renderGroup(name, svcs, grants))
				.join('')

	const wardenConfig = JSON.stringify({
		grants,
		wardenServiceName: config.wardenServiceName,
	})

	const body = `
		${renderPulseBar(pulse)}
		<div id="services-container">
			${groupHtml}
		</div>
		<div id="reconnect-overlay" class="d-none">
			<div class="reconnect-content">
				<div class="spinner-border text-light mb-3" role="status"></div>
				<h4 class="text-light">Reconnecting to Warden...</h4>
			</div>
		</div>
		<script>window.__WARDEN__ = ${wardenConfig};</script>`

	return page('Dashboard', body, { ...opts, scripts: true })
}
