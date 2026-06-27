import { esc, page } from './html'

export function consentPage(clientName: string, scopes: string[], challengeId: string, error?: string): Response {
	const scopeItems = scopes.filter(Boolean).map(s => `<li><code>${esc(s)}</code></li>`).join('\n\t\t\t')
	const errorHtml = error
		? `<div class="alert alert-danger">${esc(error)}</div>`
		: ''

	return page('Authorize', `
	<div class="d-flex justify-content-center align-items-center" style="min-height: 60vh">
		<div class="card shadow" style="max-width: 480px; width: 100%">
			<div class="card-body p-4">
				<h3 class="mb-3">Authorize Application</h3>
				${errorHtml}
				<p><strong>${esc(clientName)}</strong> is requesting access to:</p>
				<ul class="mb-3">
					${scopeItems}
				</ul>
				<p class="text-muted small">Sign in with your Orbit credentials to continue.</p>
				<form method="POST" action="/login/consent/">
					<input type="hidden" name="challenge" value="${esc(challengeId)}">
					<div class="mb-3">
						<label for="email" class="form-label">Email</label>
						<input type="email" class="form-control" id="email" name="email" required autofocus>
					</div>
					<div class="mb-3">
						<label for="password" class="form-label">Password</label>
						<input type="password" class="form-control" id="password" name="password" required>
					</div>
					<div class="d-flex gap-2">
						<button type="submit" name="decision" value="approve" class="btn btn-primary flex-fill">Allow</button>
						<button type="submit" name="decision" value="deny" class="btn btn-outline-secondary flex-fill">Deny</button>
					</div>
				</form>
			</div>
		</div>
	</div>`)
}

export function consentErrorPage(message: string): Response {
	return page('Consent Error', `
	<div class="d-flex justify-content-center align-items-center" style="min-height: 60vh">
		<div class="card shadow" style="max-width: 480px; width: 100%">
			<div class="card-body p-4 text-center">
				<h3 class="mb-3">Authorization Error</h3>
				<div class="alert alert-danger">${esc(message)}</div>
				<a href="/login" class="btn btn-primary">Back to login</a>
			</div>
		</div>
	</div>`)
}
