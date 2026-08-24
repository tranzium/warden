import { esc, page } from './html'
import { config } from '../shared/config'

function orbitBody(): string {
	return `
	<h3 class="mb-3">Warden</h3>
	<p class="text-muted mb-4">Service control panel</p>
	<a href="/login/start" class="btn btn-primary btn-lg w-100">Sign in with Orbit</a>`
}

function localBody(error?: string): string {
	const errorHtml = error ? `<div class="alert alert-danger">${esc(error)}</div>` : ''
	return `
	<h3 class="mb-3">Warden</h3>
	<p class="text-muted mb-4">Service control panel</p>
	${errorHtml}
	<form method="POST" action="/login">
		<div class="mb-3 text-start">
			<label for="username" class="form-label">Username</label>
			<input type="text" class="form-control" id="username" name="username" autocomplete="username" required autofocus>
		</div>
		<div class="mb-3 text-start">
			<label for="password" class="form-label">Password</label>
			<input type="password" class="form-control" id="password" name="password" autocomplete="current-password" required>
		</div>
		<button type="submit" class="btn btn-primary btn-lg w-100">Sign in</button>
	</form>`
}

export function loginPage(error?: string): Response {
	const body = config.authMode === 'orbit' ? orbitBody() : localBody(error)
	return page('Sign in', `
	<div class="d-flex justify-content-center align-items-center" style="min-height: 60vh">
		<div class="card shadow" style="max-width: 400px; width: 100%">
			<div class="card-body text-center p-4">
				${body}
			</div>
		</div>
	</div>`)
}
