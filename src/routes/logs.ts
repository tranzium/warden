import { readdirSync, statSync } from 'node:fs'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import { type AuthContext, hasPermission } from '../auth/middleware'
import { nssmGet, nssmList } from '../nssm/client'
import { ok, badRequest, forbidden, notFound } from '../shared/http'
import { html403, html404 } from '../views/html'
import { logsPage } from '../views/logs'

const TAIL_BYTES = 65536

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
}

function decodeChunk(buf: ArrayBuffer, atStart: boolean): string {
	let text = new TextDecoder('utf-8').decode(buf)
	if (atStart && text.charCodeAt(0) === 0xfeff) text = text.slice(1)
	return stripAnsi(text)
}

async function resolveService(name: string): Promise<string | null> {
	const nssmNames = await nssmList()
	return nssmNames.find(n => n.toLowerCase() === name.toLowerCase()) ?? null
}

export async function logsPageHandler(ctx: AuthContext, name: string): Promise<Response> {
	if (!hasPermission(ctx, 'services.logs')) return html403('You do not have permission to view logs')

	const actual = await resolveService(name)
	if (!actual) return html404()

	return logsPage(actual, { userName: ctx.user.email, grants: ctx.grants })
}

export async function logsDataHandler(ctx: AuthContext, name: string, req: Request): Promise<Response> {
	if (!hasPermission(ctx, 'services.logs')) return forbidden()

	const actual = await resolveService(name)
	if (!actual) return notFound(`Service '${name}' not found`)

	const url = new URL(req.url)
	const stream = url.searchParams.get('stream') === 'stderr' ? 'stderr' : 'stdout'
	const param = stream === 'stderr' ? 'AppStderr' : 'AppStdout'

	const activePath = await nssmGet(actual, param)
	if (!activePath) return ok({ configured: false, stream })

	const dir = dirname(activePath)
	const ext = extname(activePath)
	const stem = basename(activePath, ext)
	const rotatedRe = new RegExp(`^${escapeRegExp(stem)}-.+${escapeRegExp(ext)}$`)

	let files: Array<{ name: string; mtime: number; size: number }> = []
	try {
		files = readdirSync(dir)
			.filter(f => rotatedRe.test(f))
			.map(f => {
				const st = statSync(join(dir, f))
				return { name: f, mtime: st.mtimeMs, size: st.size }
			})
			.sort((a, b) => b.mtime - a.mtime)
	} catch {
		files = []
	}

	// Requested rotated file, contained to the log directory
	const requestedFile = url.searchParams.get('file')
	let targetPath = activePath
	let isActive = true
	if (requestedFile) {
		if (!rotatedRe.test(requestedFile)) return badRequest('Invalid file')
		const candidate = resolve(dir, requestedFile)
		if (!candidate.startsWith(resolve(dir) + sep)) return badRequest('Invalid file')
		targetPath = candidate
		isActive = false
	}

	const file = Bun.file(targetPath)
	const exists = await file.exists()
	if (!exists) {
		return ok({ configured: true, exists: false, stream, path: targetPath, active: isActive, files, size: 0, offset: 0, chunk: '' })
	}

	const size = file.size
	const offsetParam = url.searchParams.get('offset')

	let start: number
	let rotated = false
	if (isActive && offsetParam !== null) {
		const offset = Number(offsetParam)
		if (Number.isFinite(offset) && offset >= 0 && offset <= size) {
			start = offset
		} else {
			// Offset ahead of the file's current size means it rotated/truncated underneath us
			start = Math.max(0, size - TAIL_BYTES)
			rotated = true
		}
	} else {
		start = Math.max(0, size - TAIL_BYTES)
	}

	let chunk = ''
	if (start < size) {
		const buf = await file.slice(start, size).arrayBuffer()
		chunk = decodeChunk(buf, start === 0)
	}

	return ok({
		configured: true,
		exists: true,
		stream,
		path: targetPath,
		active: isActive,
		files,
		size,
		offset: size,
		chunk,
		rotated,
	})
}
