// Warden Command Centre — client-side polling and interactions
;(function () {
	'use strict'

	const POLL_INTERVAL = 5000
	const RECONNECT_INTERVAL = 2000
	const cfg = window.__WARDEN__ || {}
	const grants = cfg.grants || {}
	const wardenServiceName = cfg.wardenServiceName || 'warden'
	const logsDir = cfg.logsDir || 'D:\\logs'

	let pollTimer = null
	let reconnecting = false

	// --- Status helpers ---

	function statusLabel(svc) {
		return svc.missing ? 'Missing' : svc.status
	}

	function badgeClass(svc) {
		if (svc.missing) return 'bg-secondary'
		switch (svc.status) {
			case 'Running': return 'bg-success'
			case 'Stopped':
			case 'Unknown': return 'bg-danger'
			case 'Paused': return 'bg-warning text-dark'
			default: return 'bg-secondary'
		}
	}

	function tileClass(svc) {
		if (svc.missing) return 'border-secondary'
		switch (svc.status) {
			case 'Stopped':
			case 'Unknown': return 'border-danger'
			case 'Paused': return 'border-warning'
			default: return ''
		}
	}

	function isPending(status) {
		return status.endsWith('Pending')
	}

	function pendingLabel(status) {
		switch (status) {
			case 'StartPending': return 'Starting…'
			case 'StopPending': return 'Stopping…'
			case 'ContinuePending': return 'Resuming…'
			case 'PausePending': return 'Pausing…'
			default: return 'Working…'
		}
	}

	function esc(s) {
		var d = document.createElement('div')
		d.textContent = s
		return d.innerHTML
	}

	// --- Toasts ---

	function showToast(message, variant) {
		variant = variant || 'success'
		var container = document.getElementById('toast-container')
		if (!container) return

		var el = document.createElement('div')
		el.className = 'toast align-items-center text-bg-' + variant + ' border-0'
		el.setAttribute('role', 'alert')
		el.setAttribute('aria-live', 'assertive')
		el.setAttribute('aria-atomic', 'true')

		var flex = document.createElement('div')
		flex.className = 'd-flex'
		var body = document.createElement('div')
		body.className = 'toast-body'
		body.textContent = message
		var closeBtn = document.createElement('button')
		closeBtn.type = 'button'
		closeBtn.className = 'btn-close btn-close-white me-2 m-auto'
		closeBtn.setAttribute('data-bs-dismiss', 'toast')
		flex.appendChild(body)
		flex.appendChild(closeBtn)
		el.appendChild(flex)
		container.appendChild(el)

		if (!window.bootstrap) return
		var toast = new bootstrap.Toast(el, { delay: 4000 })
		el.addEventListener('hidden.bs.toast', function () { el.remove() })
		toast.show()
	}

	// --- Pulse bar / self status ---

	function updatePulseBar(pulse) {
		var el = document.getElementById('pulse-badges')
		if (!el) return
		var parts = []
		if (pulse.running > 0) parts.push('<span class="badge bg-success">' + pulse.running + ' running</span>')
		if (pulse.stopped > 0) parts.push('<span class="badge bg-danger">' + pulse.stopped + ' stopped</span>')
		if (pulse.other > 0) parts.push('<span class="badge bg-secondary">' + pulse.other + ' other</span>')
		el.innerHTML = parts.join('')
	}

	function updateSelfStatus(self) {
		var el = document.getElementById('self-status')
		if (!el || !self) return
		var mins = Math.floor(self.uptime / 60)
		var hrs = Math.floor(mins / 60)
		var display = hrs > 0 ? hrs + 'h ' + (mins % 60) + 'm' : mins + 'm'
		el.title = 'Warden uptime: ' + display + ' | v' + self.version
	}

	// --- Rendering (HTML string builders, used both for fresh nodes and initial page) ---

	function logsLinkHtml(svc) {
		if (!grants['services.logs'] || svc.missing) return ''
		return '<a class="btn btn-sm btn-outline-secondary" href="/services/' + encodeURIComponent(svc.name) + '/logs" title="View logs for ' + esc(svc.display || svc.name) + '">Logs</a>'
	}

	function manageMenuHtml(svc) {
		var items = []

		if (grants['services.register']) {
			if (items.length > 0) items.push('<li><hr class="dropdown-divider"></li>')
			items.push('<li><a class="dropdown-item edit-btn" href="#"' +
				' data-service="' + esc(svc.name) + '"' +
				' data-display="' + esc(svc.display || '') + '"' +
				' data-description="' + esc(svc.description || '') + '"' +
				' data-group="' + esc(svc.group_name || '') + '"' +
				' data-managed="' + (svc.managed ? '1' : '0') + '">Edit</a></li>')
			items.push('<li><a class="dropdown-item toggle-hidden-btn" href="#"' +
				' data-service="' + esc(svc.name) + '"' +
				' data-hidden="' + (svc.hidden ? '1' : '0') + '">' + (svc.hidden ? 'Show' : 'Hide') + '</a></li>')
			if (svc.missing) {
				items.push('<li><a class="dropdown-item text-danger delete-btn" href="#"' +
					' data-service="' + esc(svc.name) + '"' +
					' data-display="' + esc(svc.display || svc.name) + '"' +
					' data-confirm="Remove the entry for ' + esc(svc.display || svc.name) + '? Its saved group and settings will be forgotten.">Remove entry</a></li>')
			}
		}

		if (grants['services.install'] && !svc.missing) {
			if (items.length > 0) items.push('<li><hr class="dropdown-divider"></li>')
			items.push('<li><a class="dropdown-item" href="/services/' + encodeURIComponent(svc.name) + '/settings">Settings&hellip;</a></li>')
		}

		if (grants['services.install'] && !svc.missing && svc.name !== wardenServiceName) {
			if (items.length > 0) items.push('<li><hr class="dropdown-divider"></li>')
			items.push('<li><a class="dropdown-item text-danger uninstall-btn" href="#"' +
				' data-service="' + esc(svc.name) + '"' +
				' data-display="' + esc(svc.display || svc.name) + '">Uninstall&hellip;</a></li>')
		}

		if (!items.length) return ''
		return '<div class="dropdown">' +
			'<button class="btn btn-sm btn-outline-secondary border-0 py-0 px-1" type="button" data-bs-toggle="dropdown" aria-expanded="false">&#8942;</button>' +
			'<ul class="dropdown-menu dropdown-menu-end">' + items.join('') + '</ul></div>'
	}

	function actionButtonsHtml(svc) {
		if (svc.missing || !svc.managed) return ''
		if (isPending(svc.status)) {
			return '<div class="btn-group"><button class="btn btn-outline-secondary btn-sm" type="button" disabled>' + esc(pendingLabel(svc.status)) + '</button></div>'
		}
		var isSelf = svc.name === wardenServiceName
		var btns = []

		if (svc.status === 'Stopped' || svc.status === 'Paused' || svc.status === 'Unknown') {
			if (grants['services.start']) {
				btns.push('<button class="btn btn-outline-success btn-sm action-btn" data-action="start" data-service="' + esc(svc.name) + '">Start</button>')
			}
		}

		if (svc.status === 'Running' || svc.status === 'Paused') {
			if (grants['services.stop'] && !isSelf) {
				btns.push('<button class="btn btn-outline-danger btn-sm action-btn" data-action="stop" data-service="' + esc(svc.name) + '" data-confirm="Stop ' + esc(svc.display || svc.name) + '?">Stop</button>')
			}
			if (grants['services.restart']) {
				var msg = isSelf
					? 'Restarting warden will disconnect the dashboard for ~10 seconds. Continue?'
					: 'Restart ' + (svc.display || svc.name) + '?'
				btns.push('<button class="btn btn-outline-warning btn-sm action-btn" data-action="restart" data-service="' + esc(svc.name) + '" data-confirm="' + esc(msg) + '"' + (isSelf ? ' data-self="true"' : '') + '>Restart</button>')
			}
		}

		return btns.length ? '<div class="btn-group">' + btns.join('') + '</div>' : ''
	}

	// Bottom row: controls left, Logs right. Mirrors renderTileFooter in dashboard.ts.
	// The Logs link is static per tile; patchTile only rewrites .tile-actions.
	function footerHtml(svc) {
		var actions = actionButtonsHtml(svc)
		var logs = logsLinkHtml(svc)
		if (!actions && !logs) return ''
		return '<div class="d-flex justify-content-between align-items-center gap-2 mt-2 tile-footer">' +
			'<div class="tile-actions">' + actions + '</div>' + logs + '</div>'
	}

	function tileHtml(svc) {
		return '<div class="service-col col-xl-3 col-lg-4 col-md-6' + (svc.hidden ? ' svc-hidden' : '') + '"' +
			' data-service="' + esc(svc.name) + '"' +
			' data-hidden="' + (svc.hidden ? '1' : '0') + '"' +
			' data-missing="' + (svc.missing ? '1' : '0') + '">' +
			'<div class="card service-tile shadow-sm ' + tileClass(svc) + '">' +
			'<div class="card-body">' +
			'<div class="d-flex justify-content-between align-items-start mb-1">' +
			'<h6 class="card-title mb-0">' + esc(svc.display || svc.name) + '</h6>' +
			'<div class="d-flex align-items-center gap-1">' +
			'<span class="badge ' + badgeClass(svc) + ' status-badge text-uppercase">' + esc(statusLabel(svc)) + '</span>' +
			manageMenuHtml(svc) +
			'</div>' +
			'</div>' +
			(svc.description ? '<p class="card-text text-muted small mb-0">' + esc(svc.description) + '</p>' : '') +
			footerHtml(svc) +
			'</div></div></div>'
	}

	// --- Group collapse persistence ---

	function getCollapsedGroups() {
		try {
			return JSON.parse(localStorage.getItem('warden.collapsedGroups') || '[]')
		} catch (e) {
			return []
		}
	}

	function isGroupCollapsed(name) {
		return getCollapsedGroups().indexOf(name) !== -1
	}

	function setGroupCollapsed(name, collapsed) {
		var list = getCollapsedGroups()
		var idx = list.indexOf(name)
		if (collapsed && idx === -1) list.push(name)
		if (!collapsed && idx !== -1) list.splice(idx, 1)
		localStorage.setItem('warden.collapsedGroups', JSON.stringify(list))
	}

	function bindCollapsePersistence() {
		document.addEventListener('show.bs.collapse', function (e) {
			var group = e.target.closest('.service-group')
			if (group) setGroupCollapsed(group.dataset.groupName, false)
		})
		document.addEventListener('hide.bs.collapse', function (e) {
			var group = e.target.closest('.service-group')
			if (group) setGroupCollapsed(group.dataset.groupName, true)
		})
	}

	function applyCollapsedState() {
		document.querySelectorAll('.service-group').forEach(function (groupEl) {
			var collapsed = isGroupCollapsed(groupEl.dataset.groupName)
			var collapseEl = groupEl.querySelector('.collapse')
			var header = groupEl.querySelector('.group-header')
			if (!collapseEl) return
			collapseEl.classList.toggle('show', !collapsed)
			if (header) header.setAttribute('aria-expanded', String(!collapsed))
		})
	}

	function groupHtml(name, services) {
		var running = services.filter(function (s) { return s.status === 'Running' }).length
		var total = services.length
		var allUp = running === total
		var allHidden = services.every(function (s) { return s.hidden })
		var bc = allUp ? 'bg-success' : 'bg-warning text-dark'
		var cid = 'group-' + name.replace(/\s+/g, '-').toLowerCase()
		var collapsed = isGroupCollapsed(name)

		return '<div class="service-group mb-4' + (allHidden ? ' svc-hidden' : '') + '" data-group-name="' + esc(name) + '">' +
			'<h5 class="d-flex align-items-center gap-2 mb-3 group-header user-select-none" role="button" data-bs-toggle="collapse" data-bs-target="#' + cid + '" aria-expanded="' + (!collapsed) + '">' +
			'<span>' + esc(name) + '</span>' +
			'<span class="badge ' + bc + ' group-pulse">' + running + '/' + total + '</span>' +
			'</h5>' +
			'<div class="collapse' + (collapsed ? '' : ' show') + '" id="' + cid + '">' +
			'<div class="row g-3"></div></div></div>'
	}

	function createElementFromHtml(html) {
		var wrapper = document.createElement('div')
		wrapper.innerHTML = html
		return wrapper.firstElementChild
	}

	// Insert `els` into `parent` in order, without moving nodes that are already
	// in their correct slot. A blind appendChild on every poll detaches and
	// re-inserts every node even when nothing changed, which defeats scroll
	// anchoring and can interrupt open dropdowns/collapses.
	function reorderChildren(parent, els) {
		var prev = null
		els.forEach(function (el) {
			var expectedNext = prev ? prev.nextElementSibling : parent.firstElementChild
			if (expectedNext !== el) {
				parent.insertBefore(el, expectedNext)
			}
			prev = el
		})
	}

	// --- Tile / group patching ---

	function patchTile(el, svc) {
		var card = el.querySelector('.service-tile')
		card.className = 'card service-tile shadow-sm ' + tileClass(svc)

		el.querySelector('.card-title').textContent = svc.display || svc.name

		var badge = el.querySelector('.status-badge')
		badge.className = 'badge ' + badgeClass(svc) + ' status-badge text-uppercase'
		badge.textContent = statusLabel(svc)

		var body = card.querySelector('.card-body')
		var header = body.querySelector('.d-flex.justify-content-between')
		var descEl = body.querySelector('.card-text')
		if (svc.description) {
			if (!descEl) {
				descEl = document.createElement('p')
				descEl.className = 'card-text text-muted small mb-0'
				header.insertAdjacentElement('afterend', descEl)
			}
			descEl.textContent = svc.description
		} else if (descEl) {
			descEl.remove()
		}

		// Footer holds the controls (left) and the static Logs link (right). The Logs
		// link never changes for a live tile, so only .tile-actions is rewritten; the
		// whole footer is added/removed when the action set appears or disappears.
		var footer = body.querySelector('.tile-footer')
		var actionsHtml = actionButtonsHtml(svc)
		var logsHtml = logsLinkHtml(svc)
		if (!actionsHtml && !logsHtml) {
			if (footer) footer.remove()
		} else if (footer) {
			var actionsSlot = footer.querySelector('.tile-actions')
			if (actionsSlot) actionsSlot.innerHTML = actionsHtml
		} else {
			body.insertAdjacentHTML('beforeend', footerHtml(svc))
		}

		var editBtn = el.querySelector('.edit-btn')
		if (editBtn) {
			editBtn.dataset.display = svc.display || ''
			editBtn.dataset.description = svc.description || ''
			editBtn.dataset.group = svc.group_name || ''
			editBtn.dataset.managed = svc.managed ? '1' : '0'
		}
		var uninstallBtn = el.querySelector('.uninstall-btn')
		if (uninstallBtn) uninstallBtn.dataset.display = svc.display || svc.name
	}

	function patchGroup(groupEl, services) {
		var running = services.filter(function (s) { return s.status === 'Running' }).length
		var total = services.length
		var allUp = running === total
		var allHidden = services.every(function (s) { return s.hidden })
		groupEl.classList.toggle('svc-hidden', allHidden)
		var badge = groupEl.querySelector('.group-pulse')
		if (!badge) return
		badge.className = 'badge ' + (allUp ? 'bg-success' : 'bg-warning text-dark') + ' group-pulse'
		badge.textContent = running + '/' + total
	}

	function updateGroupsDatalist(services) {
		var datalist = document.getElementById('svc-groups-list')
		if (!datalist) return
		var seen = {}
		var groups = []
		services.forEach(function (s) {
			if (s.group_name && !seen[s.group_name]) {
				seen[s.group_name] = true
				groups.push(s.group_name)
			}
		})
		groups.sort()
		datalist.innerHTML = groups.map(function (g) { return '<option value="' + esc(g) + '">' }).join('')
	}

	// --- Group filter / show-hidden toggle ---

	function updateGroupFilter(services) {
		var select = document.getElementById('group-filter')
		if (!select) return
		var seen = {}
		var groups = []
		services.forEach(function (s) {
			var g = s.group_name || 'Ungrouped'
			if (!seen[g]) {
				seen[g] = true
				groups.push(g)
			}
		})
		groups.sort()
		var current = select.value
		select.innerHTML = '<option value="">All groups</option>' + groups.map(function (g) {
			return '<option value="' + esc(g) + '">' + esc(g) + '</option>'
		}).join('')
		if (current && groups.indexOf(current) !== -1) {
			select.value = current
		} else if (current) {
			select.value = ''
			localStorage.setItem('warden.groupFilter', '')
		}
	}

	function applyFilters() {
		var select = document.getElementById('group-filter')
		var toggle = document.getElementById('show-hidden-toggle')
		var filter = select ? select.value : ''
		var showHidden = toggle ? toggle.checked : false

		// Groups hide when filtered out, or when every service in them is hidden
		// and "Show hidden" is off. Hidden tiles hide outright, or dim when shown.
		document.querySelectorAll('.service-group').forEach(function (el) {
			var filteredOut = !!filter && el.dataset.groupName !== filter
			var hiddenGroup = el.classList.contains('svc-hidden') && !showHidden
			el.classList.toggle('d-none', filteredOut || hiddenGroup)
		})

		document.querySelectorAll('.service-col.svc-hidden').forEach(function (el) {
			el.classList.toggle('d-none', !showHidden)
			var card = el.querySelector('.service-tile')
			if (card) card.classList.toggle('opacity-50', showHidden)
		})
	}

	function bindFilterControls() {
		var select = document.getElementById('group-filter')
		var toggle = document.getElementById('show-hidden-toggle')

		if (select) {
			select.value = localStorage.getItem('warden.groupFilter') || ''
			if (select.selectedIndex === -1) select.value = ''
			select.addEventListener('change', function () {
				localStorage.setItem('warden.groupFilter', select.value)
				applyFilters()
			})
		}
		if (toggle) {
			toggle.checked = localStorage.getItem('warden.showHidden') === '1'
			toggle.addEventListener('change', function () {
				localStorage.setItem('warden.showHidden', toggle.checked ? '1' : '0')
				applyFilters()
			})
		}
		applyFilters()
	}

	function updateServices(data) {
		updatePulseBar(data.pulse)
		updateSelfStatus(data.self)

		var container = document.getElementById('services-container')
		if (!container) return

		var services = data.services || []
		updateGroupsDatalist(services)
		updateGroupFilter(services)

		if (services.length === 0) {
			container.innerHTML = '<div class="text-center text-muted mt-5"><h4>No services found</h4><p>NSSM-managed services appear here automatically.</p></div>'
			return
		}
		if (container.querySelector('.text-center.text-muted')) {
			container.innerHTML = ''
		}

		// Group
		var groups = {}
		services.forEach(function (s) {
			var g = s.group_name || 'Ungrouped'
			if (!groups[g]) groups[g] = []
			groups[g].push(s)
		})

		// Sort within group alphabetically by display name — stable across status changes,
		// so a tile doesn't jump position mid-action (matches the server-rendered order).
		Object.keys(groups).forEach(function (g) {
			groups[g].sort(function (a, b) {
				var an = (a.display || a.name).toLowerCase()
				var bn = (b.display || b.name).toLowerCase()
				return an < bn ? -1 : an > bn ? 1 : 0
			})
		})

		// Index existing tiles across the whole container, regardless of current group,
		// so a service that moved groups (edited group_name) is moved rather than recreated.
		// Only the .service-col wrapper counts — menu items and action buttons inside the
		// tile carry data-service too, and matching them here duplicated tiles every poll.
		var existingTiles = {}
		container.querySelectorAll('.service-col').forEach(function (el) {
			existingTiles[el.dataset.service] = el
		})

		var existingGroups = {}
		container.querySelectorAll('.service-group').forEach(function (el) {
			existingGroups[el.dataset.groupName] = el
		})

		var groupNames = Object.keys(groups).sort()

		var orderedGroupEls = groupNames.map(function (name) {
			var groupEl = existingGroups[name]
			if (!groupEl) {
				groupEl = createElementFromHtml(groupHtml(name, groups[name]))
			} else {
				patchGroup(groupEl, groups[name])
				delete existingGroups[name]
			}

			var row = groupEl.querySelector('.row')
			var orderedTiles = groups[name].map(function (svc) {
				var tile = existingTiles[svc.name]
				if (tile) {
					delete existingTiles[svc.name]
					// hidden/missing change the manage menu structure — rebuild rather than patch
					if (tile.dataset.hidden !== (svc.hidden ? '1' : '0') || tile.dataset.missing !== (svc.missing ? '1' : '0')) {
						var fresh = createElementFromHtml(tileHtml(svc))
						tile.remove()
						tile = fresh
					} else {
						patchTile(tile, svc)
					}
				} else {
					tile = createElementFromHtml(tileHtml(svc))
				}
				return tile
			})
			reorderChildren(row, orderedTiles)

			return groupEl
		})
		reorderChildren(container, orderedGroupEls)

		// Remove groups no longer present
		Object.keys(existingGroups).forEach(function (name) {
			existingGroups[name].remove()
		})
		// Remove tiles for services no longer present (e.g. uninstalled elsewhere)
		Object.keys(existingTiles).forEach(function (name) {
			existingTiles[name].remove()
		})

		applyFilters()
	}

	// --- Actions ---

	function performAction(service, action, isSelfRestart) {
		fetch('/services/' + encodeURIComponent(service) + '/' + action, {
			method: 'POST',
			headers: { Accept: 'application/json' },
		})
			.then(function (res) {
				if (res.status === 401) {
					window.location.href = '/login'
					return
				}
				if (res.status === 403) {
					showToast('Permission denied', 'danger')
					return
				}
				if (isSelfRestart) {
					showReconnectOverlay()
					return
				}
				if (!res.ok) {
					showToast('Failed to ' + action + ' service', 'danger')
					return
				}
				// Trigger an immediate poll to reflect the change
				poll()
			})
			.catch(function (err) {
				if (isSelfRestart) {
					showReconnectOverlay()
					return
				}
				console.error('Action failed:', err)
				showToast('Action failed — check connection', 'danger')
			})
	}

	// --- Install / edit / hide / uninstall ---

	var serviceModalEl = document.getElementById('service-modal')
	var serviceModal = null
	var stdoutTouched = false
	var stderrTouched = false

	function getServiceModal() {
		if (!serviceModal && serviceModalEl && window.bootstrap) {
			serviceModal = new bootstrap.Modal(serviceModalEl)
		}
		return serviceModal
	}

	function hideFormError() {
		var err = document.getElementById('service-form-error')
		if (err) {
			err.classList.add('d-none')
			err.textContent = ''
		}
	}

	function showFormError(msg) {
		var err = document.getElementById('service-form-error')
		if (err) {
			err.textContent = msg
			err.classList.remove('d-none')
		}
	}

	function setModalMode(mode) {
		if (!serviceModalEl) return
		serviceModalEl.querySelectorAll('.install-only').forEach(function (el) {
			el.classList.toggle('d-none', mode !== 'install')
		})
		serviceModalEl.querySelectorAll('.edit-only').forEach(function (el) {
			el.classList.toggle('d-none', mode !== 'edit')
		})
	}

	function resetServiceForm() {
		document.getElementById('svc-mode').value = 'install'
		document.getElementById('svc-original-name').value = ''
		var nameInput = document.getElementById('svc-name')
		nameInput.value = ''
		nameInput.disabled = false
		document.getElementById('svc-program').value = ''
		document.getElementById('svc-args').value = ''
		document.getElementById('svc-directory').value = ''
		document.getElementById('svc-start').value = 'auto'
		document.getElementById('svc-stdout').value = ''
		document.getElementById('svc-stderr').value = ''
		document.getElementById('svc-display').value = ''
		document.getElementById('svc-description').value = ''
		document.getElementById('svc-group').value = ''
		document.getElementById('svc-managed').checked = true
		stdoutTouched = false
		stderrTouched = false
		hideFormError()
	}

	function prefillLogPaths() {
		if (document.getElementById('svc-mode').value !== 'install') return
		var name = document.getElementById('svc-name').value.trim()
		var base = name ? logsDir + '\\' + name + '\\' : ''
		if (!stdoutTouched) document.getElementById('svc-stdout').value = base ? base + 'stdout.log' : ''
		if (!stderrTouched) document.getElementById('svc-stderr').value = base ? base + 'stderr.log' : ''
	}

	function openInstallModal() {
		resetServiceForm()
		setModalMode('install')
		document.getElementById('service-modal-title').textContent = 'Install service'
		document.getElementById('service-form-submit').textContent = 'Install'
		var modal = getServiceModal()
		if (modal) modal.show()
	}

	function openEditModal(el) {
		resetServiceForm()
		setModalMode('edit')
		document.getElementById('svc-mode').value = 'edit'
		document.getElementById('svc-original-name').value = el.dataset.service
		var nameInput = document.getElementById('svc-name')
		nameInput.value = el.dataset.service
		nameInput.disabled = true
		document.getElementById('svc-display').value = el.dataset.display || ''
		document.getElementById('svc-description').value = el.dataset.description || ''
		document.getElementById('svc-group').value = el.dataset.group || ''
		document.getElementById('svc-managed').checked = el.dataset.managed === '1'
		document.getElementById('service-modal-title').textContent = 'Edit service'
		document.getElementById('service-form-submit').textContent = 'Save changes'
		var modal = getServiceModal()
		if (modal) modal.show()
	}

	function deleteService(name, label) {
		fetch('/services/' + encodeURIComponent(name), {
			method: 'DELETE',
			headers: { Accept: 'application/json' },
		})
			.then(function (res) {
				if (res.status === 401) {
					window.location.href = '/login'
					return
				}
				if (res.status === 403) {
					showToast('Permission denied', 'danger')
					return
				}
				if (!res.ok) {
					showToast('Failed to remove ' + label, 'danger')
					return
				}
				showToast(label + ' removed', 'success')
				poll()
			})
			.catch(function (err) {
				console.error('Delete failed:', err)
				showToast('Delete failed — check connection', 'danger')
			})
	}

	function toggleHidden(name, currentlyHidden) {
		fetch('/services/' + encodeURIComponent(name), {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
			body: JSON.stringify({ hidden: !currentlyHidden }),
		})
			.then(function (res) {
				if (res.status === 401) {
					window.location.href = '/login'
					return
				}
				if (!res.ok) {
					showToast('Failed to update ' + name, 'danger')
					return
				}
				showToast(name + (currentlyHidden ? ' is visible again' : ' hidden'), 'success')
				poll()
			})
			.catch(function () {
				showToast('Request failed — check connection', 'danger')
			})
	}

	function uninstallService(name, label) {
		var typed = prompt(
			'This will PERMANENTLY remove the Windows service "' + label + '".\n\n' +
			'Type the service name (' + name + ') to confirm:'
		)
		if (typed === null) return
		if (typed.trim() !== name) {
			showToast('Name did not match — uninstall cancelled', 'warning')
			return
		}
		fetch('/services/' + encodeURIComponent(name) + '/uninstall', {
			method: 'POST',
			headers: { Accept: 'application/json' },
		})
			.then(function (res) {
				if (res.status === 401) {
					window.location.href = '/login'
					return
				}
				if (res.status === 403) {
					showToast('Permission denied', 'danger')
					return
				}
				if (!res.ok) {
					return res.json().then(function (data) {
						showToast((data && data.error) || 'Uninstall failed', 'danger')
					})
				}
				showToast(label + ' uninstalled', 'success')
				poll()
			})
			.catch(function () {
				showToast('Uninstall failed — check connection', 'danger')
			})
	}

	function bindServiceForm() {
		var installBtn = document.getElementById('install-service-btn')
		if (installBtn) {
			installBtn.addEventListener('click', function () {
				openInstallModal()
			})
		}

		var nameInput = document.getElementById('svc-name')
		if (nameInput) nameInput.addEventListener('input', prefillLogPaths)
		var stdoutInput = document.getElementById('svc-stdout')
		if (stdoutInput) stdoutInput.addEventListener('input', function () { stdoutTouched = true })
		var stderrInput = document.getElementById('svc-stderr')
		if (stderrInput) stderrInput.addEventListener('input', function () { stderrTouched = true })

		var form = document.getElementById('service-form')
		if (!form) return

		form.addEventListener('submit', function (e) {
			e.preventDefault()
			hideFormError()

			var mode = document.getElementById('svc-mode').value
			var url, method, payload

			if (mode === 'edit') {
				url = '/services/' + encodeURIComponent(document.getElementById('svc-original-name').value)
				method = 'PATCH'
				payload = {
					display: document.getElementById('svc-display').value.trim() || null,
					description: document.getElementById('svc-description').value.trim() || null,
					group_name: document.getElementById('svc-group').value.trim() || null,
					managed: document.getElementById('svc-managed').checked,
				}
			} else {
				var name = document.getElementById('svc-name').value.trim()
				var program = document.getElementById('svc-program').value.trim()
				if (!name) {
					showFormError('Service name is required')
					return
				}
				if (!program) {
					showFormError('Program is required')
					return
				}
				url = '/services'
				method = 'POST'
				payload = {
					name: name,
					program: program,
					args: document.getElementById('svc-args').value.trim() || undefined,
					directory: document.getElementById('svc-directory').value.trim() || undefined,
					start: document.getElementById('svc-start').value,
					stdout: document.getElementById('svc-stdout').value.trim() || undefined,
					stderr: document.getElementById('svc-stderr').value.trim() || undefined,
					display: document.getElementById('svc-display').value.trim() || undefined,
					description: document.getElementById('svc-description').value.trim() || undefined,
					group_name: document.getElementById('svc-group').value.trim() || undefined,
				}
			}

			fetch(url, {
				method: method,
				headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
				body: JSON.stringify(payload),
			})
				.then(function (res) {
					if (res.status === 401) {
						window.location.href = '/login'
						return
					}
					if (res.ok) {
						var modal = getServiceModal()
						if (modal) modal.hide()
						showToast(mode === 'edit' ? 'Service updated' : 'Service installed', 'success')
						poll()
						return
					}
					return res.json().then(function (data) {
						showFormError((data && data.error) || 'Request failed')
					})
				})
				.catch(function () {
					showFormError('Network error — please try again')
				})
		})
	}

	// --- Delegated event bindings (bound once; new tiles work automatically) ---

	function bindDelegatedEvents() {
		document.addEventListener('click', function (e) {
			var actionBtn = e.target.closest('.action-btn')
			if (actionBtn) {
				e.preventDefault()
				var confirmMsg = actionBtn.dataset.confirm
				if (confirmMsg && !confirm(confirmMsg)) return
				performAction(actionBtn.dataset.service, actionBtn.dataset.action, actionBtn.dataset.self === 'true')
				return
			}

			var editBtn = e.target.closest('.edit-btn')
			if (editBtn) {
				e.preventDefault()
				openEditModal(editBtn)
				return
			}

			var hiddenBtn = e.target.closest('.toggle-hidden-btn')
			if (hiddenBtn) {
				e.preventDefault()
				toggleHidden(hiddenBtn.dataset.service, hiddenBtn.dataset.hidden === '1')
				return
			}

			var uninstallBtn = e.target.closest('.uninstall-btn')
			if (uninstallBtn) {
				e.preventDefault()
				uninstallService(uninstallBtn.dataset.service, uninstallBtn.dataset.display || uninstallBtn.dataset.service)
				return
			}

			var deleteBtn = e.target.closest('.delete-btn')
			if (deleteBtn) {
				e.preventDefault()
				var delConfirm = deleteBtn.dataset.confirm
				if (delConfirm && !confirm(delConfirm)) return
				deleteService(deleteBtn.dataset.service, deleteBtn.dataset.display || deleteBtn.dataset.service)
				return
			}
		})
	}

	// --- Reconnect overlay ---

	function showReconnectOverlay() {
		reconnecting = true
		stopPolling()
		var overlay = document.getElementById('reconnect-overlay')
		if (overlay) overlay.classList.remove('d-none')
		waitForReconnect()
	}

	function waitForReconnect() {
		fetch('/health')
			.then(function (res) {
				if (res.ok) {
					reconnecting = false
					window.location.reload()
				} else {
					setTimeout(waitForReconnect, RECONNECT_INTERVAL)
				}
			})
			.catch(function () {
				setTimeout(waitForReconnect, RECONNECT_INTERVAL)
			})
	}

	// --- Polling ---

	function poll() {
		if (reconnecting) return
		fetch('/services', { headers: { Accept: 'application/json' } })
			.then(function (res) {
				if (res.status === 401) {
					stopPolling()
					window.location.href = '/login'
					return
				}
				return res.json()
			})
			.then(function (data) {
				if (data) updateServices(data)
			})
			.catch(function (err) {
				console.error('Poll failed:', err)
			})
	}

	function startPolling() {
		if (pollTimer) return
		pollTimer = setInterval(poll, POLL_INTERVAL)
	}

	function stopPolling() {
		if (pollTimer) {
			clearInterval(pollTimer)
			pollTimer = null
		}
	}

	// --- Init ---

	bindDelegatedEvents()
	bindServiceForm()
	bindFilterControls()
	bindCollapsePersistence()
	applyCollapsedState()
	startPolling()
})()
