import { page } from './html'

export function loginPage(): Response {
	return page('Sign in', `
	<div class="d-flex justify-content-center align-items-center" style="min-height: 60vh">
		<div class="card shadow" style="max-width: 400px; width: 100%">
			<div class="card-body text-center p-4">
				<h3 class="mb-3">Warden</h3>
				<p class="text-muted mb-4">Service control panel</p>
				<a href="/login/start" class="btn btn-primary btn-lg w-100">Sign in with Orbit</a>
			</div>
		</div>
	</div>`)
}
