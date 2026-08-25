function required(name: string): string {
	const v = process.env[name]
	if (!v) {
		console.error(`${name} is required`)
		process.exit(1)
	}
	return v
}

const cookieSecret = required('COOKIE_SECRET')
if (cookieSecret.length < 32) {
	console.error('COOKIE_SECRET must be at least 32 characters')
	process.exit(1)
}

const port = parseInt(process.env.PORT ?? '3004')
if (isNaN(port) || port < 1 || port > 65535) {
	console.error('PORT must be a valid port number (1-65535)')
	process.exit(1)
}

const sessionTtlHours = parseInt(process.env.SESSION_TTL_HOURS ?? '168')
if (isNaN(sessionTtlHours) || sessionTtlHours < 1) {
	console.error('SESSION_TTL_HOURS must be a positive number of hours')
	process.exit(1)
}

// AUTH_MODE=local (default): single-operator login, no external dependency.
// AUTH_MODE=orbit: delegate auth to an Orbit tenant — see docs/orbit-setup.md.
const authMode = process.env.AUTH_MODE === 'orbit' ? 'orbit' : 'local'

if (authMode === 'local' && !process.env.AUTH_PASSWORD_HASH) {
	console.error('AUTH_PASSWORD_HASH is required in local auth mode — generate one with: bun run scripts/hash-password.ts <password>')
	process.exit(1)
}

const oauthRedirectUri = authMode === 'orbit' ? required('OAUTH_REDIRECT_URI') : (process.env.OAUTH_REDIRECT_URI ?? '')

export const config = Object.freeze({
	port,
	host: process.env.HOST ?? '127.0.0.1',
	cookieSecret,
	dbPath: process.env.DB_PATH ?? './data/warden.db',
	sessionTtlHours,

	authMode,
	localUsername: process.env.AUTH_USERNAME ?? 'admin',
	localPasswordHash: process.env.AUTH_PASSWORD_HASH ?? '',

	orbitIntrospectUrl: authMode === 'orbit' ? required('ORBIT_INTROSPECT_URL') : (process.env.ORBIT_INTROSPECT_URL ?? ''),
	orbitApiKey: authMode === 'orbit' ? required('ORBIT_API_KEY') : (process.env.ORBIT_API_KEY ?? ''),
	orbitTenantId: authMode === 'orbit' ? required('ORBIT_TENANT_ID') : (process.env.ORBIT_TENANT_ID ?? ''),

	oauthClientId: authMode === 'orbit' ? required('OAUTH_CLIENT_ID') : (process.env.OAUTH_CLIENT_ID ?? ''),
	oauthClientSecret: process.env.OAUTH_CLIENT_SECRET ?? '',
	oauthRedirectUri,
	oauthAuthorizeUrl: authMode === 'orbit' ? required('OAUTH_AUTHORIZE_URL') : (process.env.OAUTH_AUTHORIZE_URL ?? ''),
	oauthTokenUrl: authMode === 'orbit' ? required('OAUTH_TOKEN_URL') : (process.env.OAUTH_TOKEN_URL ?? ''),
	oauthConsentKey: (() => {
		const raw = process.env.OAUTH_CONSENT_KEY
		if (!raw) return null
		try {
			return JSON.parse(raw) as JsonWebKey
		} catch {
			console.error('OAUTH_CONSENT_KEY is not valid JSON')
			process.exit(1)
		}
	})(),

	orbitApiUrl: process.env.ORBIT_API_URL ?? '',

	nssmPath: process.env.NSSM_PATH ?? 'nssm',
	wardenServiceName: process.env.WARDEN_SERVICE_NAME ?? 'warden',
	logsDir: process.env.LOGS_DIR ?? './logs',
	secure: process.env.SECURE_COOKIES === 'true' || oauthRedirectUri.startsWith('https://'),
})
