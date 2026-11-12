// Warden - service settings: Log on card behavior
;(function () {
	'use strict'

	var card = document.getElementById('logon-card')
	var account = document.getElementById('logon-account')
	if (!card || !account) return

	var userFields = document.getElementById('logon-user-fields')
	var checkBtn = document.getElementById('logon-check')
	var hint = document.getElementById('logon-hint')
	var password = document.getElementById('logon-password')
	var confirm = document.getElementById('logon-confirm')
	var match = document.getElementById('logon-match')
	var save = document.getElementById('save')
	var kinds = document.querySelectorAll('input[name="logonKind"]')
	var lookupUrl = card.getAttribute('data-lookup')
	var lastLookup = null

	function isUser() {
		var checked = document.querySelector('input[name="logonKind"]:checked')
		return !!checked && checked.value === 'user'
	}

	function setText(el, text, cls) {
		el.textContent = text || String.fromCharCode(160) // nbsp keeps the hint line's height
		el.className = 'form-text' + (cls ? ' ' + cls : '')
	}

	function update() {
		userFields.style.display = isUser() ? '' : 'none'
		if (!isUser() || (!password.value && !confirm.value)) {
			setText(match, '')
			save.disabled = false
			return
		}
		var same = password.value === confirm.value
		setText(match, same ? 'Passwords match' : 'Passwords do not match', same ? 'text-success' : 'text-danger')
		save.disabled = !same
	}

	function lookup() {
		var value = account.value.trim()
		lastLookup = account.value
		if (!value) {
			setText(hint, '')
			return
		}
		setText(hint, 'Checking...', 'text-muted')
		fetch(lookupUrl + '?account=' + encodeURIComponent(value), { headers: { Accept: 'application/json' } })
			.then(function (res) {
				if (!res.ok) throw new Error('HTTP ' + res.status)
				return res.json()
			})
			.then(function (data) {
				if (account.value.trim() !== value) return // input changed while checking
				if (data.resolved) setText(hint, 'Resolves to ' + data.resolved, 'text-success')
				else setText(hint, data.message || 'Account not found', 'text-danger')
			})
			.catch(function () {
				setText(hint, 'Could not check account', 'text-warning')
			})
	}

	for (var i = 0; i < kinds.length; i++) kinds[i].addEventListener('change', update)
	password.addEventListener('input', update)
	confirm.addEventListener('input', update)
	checkBtn.addEventListener('click', lookup)
	account.addEventListener('blur', function () {
		if (account.value !== lastLookup) lookup()
	})
	account.addEventListener('input', function () {
		setText(hint, '')
	})

	lastLookup = account.value // prefilled current account: no lookup until edited or Check
	update()
})()
