import { config } from './shared/config'
import { router } from './router'

Bun.serve({
	port: config.port,
	hostname: config.host,
	async fetch(req) {
		try {
			return await router(req)
		} catch (err) {
			console.error(err)
			return new Response('Internal error', { status: 500 })
		}
	},
	error(err) {
		console.error(err)
		return new Response('Internal error', { status: 500 })
	},
})

console.log(`warden listening on ${config.host}:${config.port}`)
