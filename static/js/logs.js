// Warden — service log viewer (tail-poll)
;(function () {
	'use strict'

	var POLL_INTERVAL = 2000
	var cfg = window.__WARDEN_LOGS__ || {}
	var service = cfg.service

	var pane = document.getElementById('logs-pane')
	var statusEl = document.getElementById('logs-status')
	var fileSelect = document.getElementById('file-select')
	var followToggle = document.getElementById('follow-toggle')
	var tabs = document.querySelectorAll('#stream-tabs [data-stream]')

	var state = { stream: 'stdout', file: '', offset: 0, timer: null }

	function esc(s) {
		var d = document.createElement('div')
		d.textContent = s
		return d.innerHTML
	}

	function formatSize(n) {
		if (n < 1024) return n + ' B'
		if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
		return (n / 1024 / 1024).toFixed(2) + ' MB'
	}

	function isAtBottom() {
		return pane.scrollHeight - pane.scrollTop - pane.clientHeight < 40
	}

	function append(text) {
		var atBottom = isAtBottom()
		pane.textContent += text
		if (atBottom) pane.scrollTop = pane.scrollHeight
	}

	function reset() {
		pane.textContent = ''
		state.offset = 0
	}

	function updateFileSelect(files) {
		var current = fileSelect.value
		var opts = ['<option value="">Current</option>']
		files.forEach(function (f) {
			opts.push('<option value="' + esc(f.name) + '">' + esc(f.name) + ' (' + new Date(f.mtime).toLocaleString() + ')</option>')
		})
		fileSelect.innerHTML = opts.join('')
		if (current && files.some(function (f) { return f.name === current })) fileSelect.value = current
	}

	function stopPolling() {
		if (state.timer) {
			clearTimeout(state.timer)
			state.timer = null
		}
	}

	function scheduleNext() {
		stopPolling()
		if (state.file) return // viewing a historical rotated file — no live follow
		if (!followToggle.checked) return
		state.timer = setTimeout(load, POLL_INTERVAL)
	}

	function load() {
		var params = new URLSearchParams({ stream: state.stream })
		if (state.file) params.set('file', state.file)
		else if (state.offset) params.set('offset', String(state.offset))

		fetch('/services/' + encodeURIComponent(service) + '/logs/data?' + params.toString(), {
			headers: { Accept: 'application/json' },
		})
			.then(function (res) {
				if (res.status === 401) {
					window.location.href = '/login'
					return
				}
				if (res.status === 403) {
					statusEl.textContent = 'Permission denied.'
					stopPolling()
					return
				}
				if (res.status === 404) {
					statusEl.textContent = 'Service not found.'
					stopPolling()
					return
				}
				return res.json()
			})
			.then(function (data) {
				if (!data) return

				if (!data.configured) {
					pane.textContent = ''
					statusEl.textContent = 'No ' + state.stream + ' log configured for this service.'
					return
				}

				updateFileSelect(data.files || [])

				if (!data.exists) {
					pane.textContent = ''
					statusEl.textContent = data.path + ' — not created yet.'
					state.offset = 0
					scheduleNext()
					return
				}

				if (data.rotated) {
					pane.textContent = ''
					append('--- log rotated ---\n')
				}
				if (data.chunk) append(data.chunk)
				state.offset = data.offset

				statusEl.textContent = data.path + ' (' + formatSize(data.size) + ')' + (data.active ? '' : ' — historical file')
				scheduleNext()
			})
			.catch(function () {
				statusEl.textContent = 'Failed to load logs — retrying…'
				scheduleNext()
			})
	}

	tabs.forEach(function (btn) {
		btn.addEventListener('click', function () {
			tabs.forEach(function (b) { b.classList.toggle('active', b === btn) })
			state.stream = btn.dataset.stream
			state.file = ''
			fileSelect.value = ''
			reset()
			load()
		})
	})

	fileSelect.addEventListener('change', function () {
		state.file = fileSelect.value
		reset()
		load()
	})

	followToggle.addEventListener('change', function () {
		if (followToggle.checked && !state.file) load()
		else stopPolling()
	})

	load()
})()
