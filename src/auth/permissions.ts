export const ALL_PERMISSIONS = [
	'services.view',
	'services.start',
	'services.stop',
	'services.restart',
	'services.register',
	'services.install',
	'services.logs',
]

export function allGrants(): Record<string, boolean> {
	return Object.fromEntries(ALL_PERMISSIONS.map(p => [p, true]))
}
