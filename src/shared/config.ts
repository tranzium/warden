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

export const config = Object.freeze({
	port,
	host: process.env.HOST ?? '0.0.0.0',
	cookieSecret,
	dbPath: process.env.DB_PATH ?? './data/warden.db',

	orbitIntrospectUrl: required('ORBIT_INTROSPECT_URL'),
	orbitApiKey: required('ORBIT_API_KEY'),
	orbitTenantId: required('ORBIT_TENANT_ID'),

	oauthClientId: required('OAUTH_CLIENT_ID'),
	oauthClientSecret: process.env.OAUTH_CLIENT_SECRET ?? '',
	oauthRedirectUri: required('OAUTH_REDIRECT_URI'),
	oauthAuthorizeUrl: required('OAUTH_AUTHORIZE_URL'),
	oauthTokenUrl: required('OAUTH_TOKEN_URL'),
	oauthConsentKey: process.env.OAUTH_CONSENT_KEY
		? JSON.parse(process.env.OAUTH_CONSENT_KEY) as JsonWebKey
		: null,

	orbitApiUrl: process.env.ORBIT_API_URL ?? '',

	nssmPath: process.env.NSSM_PATH ?? 'nssm',
	wardenServiceName: process.env.WARDEN_SERVICE_NAME ?? 'warden',
	secure: (process.env.OAUTH_REDIRECT_URI ?? '').startsWith('https://'),
})
