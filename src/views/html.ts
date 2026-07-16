export function esc(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export type PageOpts = {
	userName?: string
	grants?: Record<string, boolean>
	scripts?: boolean
	script?: string
}

const BOOTSTRAP_CSS = 'https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css'
const BOOTSTRAP_JS = 'https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js'

function renderNav(opts: PageOpts): string {
	return `
	<nav class="navbar navbar-dark bg-dark">
		<div class="container-xxl">
			<a class="navbar-brand fw-bold" href="/">WARDEN</a>
			<div class="d-flex align-items-center gap-2">
				<span id="self-status" class="badge bg-success" title="Warden is running">&#9679; warden</span>
				${opts.userName ? `<span class="navbar-text text-light">${esc(opts.userName)}</span>` : ''}
				<form method="POST" action="/logout" class="d-inline">
					<button type="submit" class="btn btn-outline-light btn-sm">Sign out</button>
				</form>
			</div>
		</div>
	</nav>`
}

function pageHtml(status: number, title: string, body: string, opts?: PageOpts): Response {
	const nav = opts?.userName ? renderNav(opts) : ''
	const scriptTag = opts?.scripts
		? `<script src="${opts.script ?? '/static/js/poll.js'}"></script>`
		: ''
	const html = `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>${esc(title)} - Warden</title>
	<link rel="stylesheet" href="${BOOTSTRAP_CSS}">
	<link rel="stylesheet" href="/static/css/warden.css">
</head>
<body>
${nav}
<main class="container-xxl mt-3">
	${body}
</main>
<script src="${BOOTSTRAP_JS}"></script>
${scriptTag}
</body>
</html>`
	return new Response(html, {
		status,
		headers: { 'Content-Type': 'text/html; charset=utf-8' },
	})
}

export function page(title: string, body: string, opts?: PageOpts): Response {
	return pageHtml(200, title, body, opts)
}

export function redirect(location: string): Response {
	return new Response(null, { status: 302, headers: { Location: location } })
}

export function html401(): Response {
	return pageHtml(
		401,
		'Unauthorized',
		'<div class="container mt-5"><h2>401 Unauthorized</h2><p>You must be signed in.</p><a href="/login" class="btn btn-primary">Sign in</a></div>',
	)
}

export function html403(message: string): Response {
	return pageHtml(403, 'Forbidden', `<div class="container mt-5"><h2>403 Forbidden</h2><p>${esc(message)}</p></div>`)
}

export function html404(): Response {
	return pageHtml(404, 'Not Found', '<div class="container mt-5"><h2>404 Not Found</h2><p>The page you requested does not exist.</p></div>')
}

export function html500(): Response {
	return pageHtml(500, 'Server Error', '<div class="container mt-5"><h2>500 Internal Server Error</h2><p>Something went wrong.</p></div>')
}
