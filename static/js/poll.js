// Warden Command Centre — client-side polling and interactions
;(function () {
	'use strict'

	const POLL_INTERVAL = 5000
	const RECONNECT_INTERVAL = 2000
	const cfg = window.__WARDEN__ || {}
	const grants = cfg.grants || {}
	const wardenServiceName = cfg.wardenServiceName || 'warden'

	let pollTimer = null
	let reconnecting = false

	// --- Status helpers ---

	function badgeClass(status) {
		switch (status) {
			case 'Running': return 'bg-success'
			case 'Stopped':
			case 'Unknown': return 'bg-danger'
			case 'Paused': return 'bg-warning text-dark'
			default: return 'bg-secondary'
		}
	}

	function tileClass(status) {
		switch (status) {
			case 'Stopped':
			case 'Unknown': return 'border-danger'
			case 'Paused': return 'border-warning'
			default: return ''
		}
	}

	function isPending(status) {
		return status.endsWith('Pending')
	}

	// --- DOM update ---

	function updatePulseBar(pulse) {
		var el = document.getElementById('pulse-bar')
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

	function buildManageMenu(svc) {
		if (!grants['services.register']) return ''
		return '<div class="dropdown">' +
			'<button class="btn btn-sm btn-outline-secondary border-0 py-0 px-1" type="button" data-bs-toggle="dropdown" aria-expanded="false">&#8942;</button>' +
			'<ul class="dropdown-menu dropdown-menu-end">' +
			'<li><a class="dropdown-item edit-btn" href="#"' +
			' data-service="' + esc(svc.name) + '"' +
			' data-display="' + esc(svc.display || '') + '"' +
			' data-description="' + esc(svc.description || '') + '"' +
			' data-group="' + esc(svc.group_name || '') + '"' +
			' data-managed="' + (svc.managed ? '1' : '0') + '">Edit</a></li>' +
			'<li><a class="dropdown-item text-danger delete-btn" href="#"' +
			' data-service="' + esc(svc.name) + '"' +
			' data-confirm="Unregister ' + esc(svc.display || svc.name) + '? This only removes it from Warden — the Windows service itself is untouched.">Delete</a></li>' +
			'</ul></div>'
	}

	function buildActionButtons(svc) {
		if (!svc.managed || isPending(svc.status)) return ''
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

		return btns.length ? '<div class="btn-group mt-2">' + btns.join('') + '</div>' : ''
	}

	function esc(s) {
		var d = document.createElement('div')
		d.textContent = s
		return d.innerHTML
	}

	function renderTile(svc) {
		return '<div class="col-xl-3 col-lg-4 col-md-6" data-service="' + esc(svc.name) + '">' +
			'<div class="card service-tile ' + tileClass(svc.status) + '">' +
			'<div class="card-body">' +
			'<div class="d-flex justify-content-between align-items-start mb-1">' +
			'<h6 class="card-title mb-0">' + esc(svc.display || svc.name) + '</h6>' +
			'<div class="d-flex align-items-center gap-1">' +
			'<span class="badge ' + badgeClass(svc.status) + ' status-badge">' + esc(svc.status) + '</span>' +
			buildManageMenu(svc) +
			'</div>' +
			'</div>' +
			(svc.description ? '<p class="card-text text-muted small mb-0">' + esc(svc.description) + '</p>' : '') +
			buildActionButtons(svc) +
			'</div></div></div>'
	}

	function renderGroup(name, services) {
		var running = services.filter(function (s) { return s.status === 'Running' }).length
		var total = services.length
		var allUp = running === total
		var bc = allUp ? 'bg-success' : 'bg-warning text-dark'
		var cid = 'group-' + name.replace(/\s+/g, '-').toLowerCase()

		return '<div class="service-group mb-4">' +
			'<h5 class="d-flex align-items-center gap-2 mb-3 group-header" role="button" data-bs-toggle="collapse" data-bs-target="#' + cid + '" aria-expanded="true">' +
			'<span>' + esc(name) + '</span>' +
			'<span class="badge ' + bc + '">' + running + '/' + total + '</span>' +
			'</h5>' +
			'<div class="collapse show" id="' + cid + '">' +
			'<div class="row g-3">' +
			services.map(renderTile).join('') +
			'</div></div></div>'
	}

	var STATE_PRIORITY = {
		Unknown: 0, Stopped: 1, Paused: 2, StopPending: 3,
		StartPending: 4, ContinuePending: 5, PausePending: 6, Running: 7,
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

	function updateServices(data) {
		updatePulseBar(data.pulse)
		updateSelfStatus(data.self)

		var container = document.getElementById('services-container')
		if (!container) return

		var services = data.services || []
		updateGroupsDatalist(services)

		if (services.length === 0) {
			container.innerHTML = '<div class="text-center text-muted mt-5"><h4>No services registered</h4><p>Register services to start managing them.</p></div>'
			return
		}

		// Group
		var groups = {}
		services.forEach(function (s) {
			var g = s.group_name || 'Ungrouped'
			if (!groups[g]) groups[g] = []
			groups[g].push(s)
		})

		// Sort within group
		Object.keys(groups).forEach(function (g) {
			groups[g].sort(function (a, b) {
				return (STATE_PRIORITY[a.status] || 99) - (STATE_PRIORITY[b.status] || 99)
			})
		})

		var html = Object.keys(groups).sort().map(function (g) {
			return renderGroup(g, groups[g])
		}).join('')

		container.innerHTML = html
		bindActionButtons()
		bindManageMenu()
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
					alert('Permission denied')
					return
				}
				if (isSelfRestart) {
					showReconnectOverlay()
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
			})
	}

	function bindActionButtons() {
		document.querySelectorAll('.action-btn').forEach(function (btn) {
			btn.addEventListener('click', function (e) {
				e.preventDefault()
				var service = this.dataset.service
				var action = this.dataset.action
				var confirmMsg = this.dataset.confirm
				var isSelfRestart = this.dataset.self === 'true'

				if (confirmMsg && !confirm(confirmMsg)) return
				performAction(service, action, isSelfRestart)
			})
		})
	}

	// --- Register / edit / delete ---

	var serviceModalEl = document.getElementById('service-modal')
	var serviceModal = null

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

	function resetServiceForm() {
		document.getElementById('svc-mode').value = 'register'
		document.getElementById('svc-original-name').value = ''
		var nameInput = document.getElementById('svc-name')
		nameInput.value = ''
		nameInput.disabled = false
		document.getElementById('svc-display').value = ''
		document.getElementById('svc-description').value = ''
		document.getElementById('svc-group').value = ''
		document.getElementById('svc-managed').checked = true
		document.getElementById('service-modal-title').textContent = 'Register service'
		document.getElementById('service-form-submit').textContent = 'Register'
		hideFormError()
	}

	function openRegisterModal() {
		resetServiceForm()
		var modal = getServiceModal()
		if (modal) modal.show()
	}

	function openEditModal(el) {
		resetServiceForm()
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

	function deleteService(name) {
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
					alert('Permission denied')
					return
				}
				poll()
			})
			.catch(function (err) {
				console.error('Delete failed:', err)
			})
	}

	function bindManageMenu() {
		document.querySelectorAll('.edit-btn').forEach(function (el) {
			el.addEventListener('click', function (e) {
				e.preventDefault()
				openEditModal(this)
			})
		})
		document.querySelectorAll('.delete-btn').forEach(function (el) {
			el.addEventListener('click', function (e) {
				e.preventDefault()
				var confirmMsg = this.dataset.confirm
				if (confirmMsg && !confirm(confirmMsg)) return
				deleteService(this.dataset.service)
			})
		})
	}

	function bindServiceForm() {
		var registerBtn = document.getElementById('register-service-btn')
		if (registerBtn) {
			registerBtn.addEventListener('click', function () {
				openRegisterModal()
			})
		}

		var form = document.getElementById('service-form')
		if (!form) return

		form.addEventListener('submit', function (e) {
			e.preventDefault()
			hideFormError()

			var mode = document.getElementById('svc-mode').value
			var name = document.getElementById('svc-name').value.trim()
			var payload = {
				display: document.getElementById('svc-display').value.trim() || null,
				description: document.getElementById('svc-description').value.trim() || null,
				group_name: document.getElementById('svc-group').value.trim() || null,
				managed: document.getElementById('svc-managed').checked,
			}

			var url, method
			if (mode === 'edit') {
				url = '/services/' + encodeURIComponent(document.getElementById('svc-original-name').value)
				method = 'PATCH'
			} else {
				if (!name) {
					showFormError('Service name is required')
					return
				}
				payload.name = name
				url = '/services'
				method = 'POST'
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

	bindActionButtons()
	bindManageMenu()
	bindServiceForm()
	startPolling()
})()
