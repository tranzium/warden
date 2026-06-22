export function ok(data: unknown): Response {
	return Response.json(data)
}

export function created(data: unknown): Response {
	return Response.json(data, { status: 201 })
}

export function noContent(): Response {
	return new Response(null, { status: 204 })
}

export function badRequest(message: string): Response {
	return Response.json({ error: message }, { status: 400 })
}

export function unauthorized(message = 'Unauthorized'): Response {
	return Response.json({ error: message }, { status: 401 })
}

export function forbidden(message = 'Forbidden'): Response {
	return Response.json({ error: message }, { status: 403 })
}

export function notFound(message = 'Not found'): Response {
	return Response.json({ error: message }, { status: 404 })
}

export function methodNotAllowed(): Response {
	return Response.json({ error: 'Method not allowed' }, { status: 405 })
}

export function unprocessable(message: string): Response {
	return Response.json({ error: message }, { status: 422 })
}

export function internalError(message = 'Internal error'): Response {
	return Response.json({ error: message }, { status: 500 })
}

export function redirect(location: string, cookie?: string): Response {
	const headers = new Headers({ Location: location })
	if (cookie) headers.append('Set-Cookie', cookie)
	return new Response(null, { status: 302, headers })
}
