// Ad-hoc smoke test for the agent-api install/configure capability: isAllowedToInstall's
// three independent gates, the hardcoded agentic-group fence (independent of token content
// or the request body), and a direct regression check that the dashboard's installHandler/
// updateHandler are unchanged by the performInstall/performUpdate extraction.
// No real NSSM install is performed here, matching smoke-install.ts's convention of only
// exercising validation and DB-only paths — never creating a real Windows service.
// Run via `bun run scripts/smoke-agent-install.ts`.
export {} // dynamic imports below do not mark this as a module on their own

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Route modules pull in the DB client; keep it off the working tree
const smokeDir = mkdtempSync(join(tmpdir(), 'warden-smoke-agent-install-'))
process.env.DB_PATH = join(smokeDir, 'warden.db')
process.env.COOKIE_SECRET = '0123456789abcdef0123456789abcdef'
process.env.AUTH_PASSWORD_HASH = await Bun.password.hash('smoke-test-password')
process.env.AGENT_TOKENS_PATH = join(smokeDir, 'agent-tokens.json')
process.env.AGENT_AUDIT_LOG_PATH = join(smokeDir, 'agent-audit.log')

const agentTokens = await import('../src/auth/agentTokens')
const agentApi = await import('../src/routes/agentApi')
const services = await import('../src/routes/services')
const db = await import('../src/db/client')

// --- isAllowedToInstall: three independent gates ---
const base = { name: 'agent', services: ['web-worker'] }
if (agentTokens.isAllowedToInstall({ ...base, canInstall: false }, 'web-worker')) throw new Error('canInstall false must block even when allowlisted')
if (agentTokens.isAllowedToInstall({ ...base, canInstall: true }, 'tf-anything')) throw new Error('denylisted name must block even when canInstall is true')
if (agentTokens.isAllowedToInstall({ ...base, canInstall: true }, 'other-service')) throw new Error('name outside the allowlist must block even when canInstall is true')
if (!agentTokens.isAllowedToInstall({ ...base, canInstall: true }, 'web-worker')) throw new Error('canInstall true, allowlisted, not denylisted must be allowed')
if (agentTokens.isAllowedToInstall({ name: 'agent', services: ['web-worker'] }, 'web-worker')) throw new Error('omitted canInstall field must default to no capability')

// --- agentInstallHandler / agentConfigureHandler: token-gate 403s, no NSSM reached ---
const installReq = (body: Record<string, unknown>) => new Request('http://x/v1/services', { method: 'POST', body: JSON.stringify(body) })
const configureReq = (body: Record<string, unknown>) => new Request('http://x/v1/services/x', { method: 'PATCH', body: JSON.stringify(body) })

const noCanInstall = { name: 'agent', services: ['agentic-svc'], canInstall: false }
let r = await agentApi.agentInstallHandler(noCanInstall, installReq({ name: 'agentic-svc', program: process.execPath }))
if (r.status !== 403) throw new Error('install without canInstall must be 403, got ' + r.status)
r = await agentApi.agentConfigureHandler(noCanInstall, 'agentic-svc', configureReq({}))
if (r.status !== 403) throw new Error('configure without canInstall must be 403, got ' + r.status)

const notAllowlisted = { name: 'agent', services: ['other-svc'], canInstall: true }
r = await agentApi.agentInstallHandler(notAllowlisted, installReq({ name: 'agentic-svc', program: process.execPath }))
if (r.status !== 403) throw new Error('install outside the token allowlist must be 403, got ' + r.status)
r = await agentApi.agentConfigureHandler(notAllowlisted, 'agentic-svc', configureReq({}))
if (r.status !== 403) throw new Error('configure outside the token allowlist must be 403, got ' + r.status)

const denylisted = { name: 'agent', services: ['tf-core'], canInstall: true }
r = await agentApi.agentInstallHandler(denylisted, installReq({ name: 'tf-core', program: process.execPath }))
if (r.status !== 403) throw new Error('install on a denylisted name must be 403, got ' + r.status)

// --- agentInstallHandler: authorized call reaches performInstall, fails at validation (no NSSM call) ---
const canInstallSvc = { name: 'agent', services: ['agentic-svc'], canInstall: true }
r = await agentApi.agentInstallHandler(canInstallSvc, installReq({ name: 'agentic-svc', program: '/no/such/program-zz' }))
if (r.status !== 422) throw new Error('authorized install with a bad program must reach shared validation (422), got ' + r.status)

// --- agentConfigureHandler: hardcoded agentic-group gate, independent of token content ---
// The service already exists outside the agentic group; the token has canInstall:true and the
// exact service name allowlisted — the group fence must still refuse it.
db.upsertService('agentic-svc', { group_name: 'other-group', managed: true })
r = await agentApi.agentConfigureHandler(canInstallSvc, 'agentic-svc', configureReq({ display: 'new' }))
if (r.status !== 403) throw new Error('configure on a service outside the agentic group must be 403 despite full token authorization, got ' + r.status)
const stillOther = db.getService('agentic-svc')
if (stillOther?.group_name !== 'other-group') throw new Error('a rejected configure must not change the row')

// Same service, now in the agentic group: configure succeeds, and an attempt to move it out
// via the request body is ignored — requireGroupName pins group_name server-side.
db.upsertService('agentic-svc', { group_name: 'agentic' })
r = await agentApi.agentConfigureHandler(canInstallSvc, 'agentic-svc', configureReq({ display: 'new', group_name: 'escape-group' }))
if (r.status !== 200) throw new Error('configure inside the agentic group must succeed, got ' + r.status)
const afterConfigure = db.getService('agentic-svc')
if (afterConfigure?.group_name !== 'agentic') throw new Error('requireGroupName must pin group_name despite a differing request body: ' + afterConfigure?.group_name)
if (afterConfigure?.display !== 'new') throw new Error('fields other than group_name must still apply: ' + JSON.stringify(afterConfigure))

// --- agentConfigureHandler cannot set hidden/managed: silently ignored, not rejected ---
// The row is currently managed: true, hidden: false (set above); a configure body asking for
// the opposite must succeed (other fields still apply) but leave both fields untouched.
if (!afterConfigure?.managed || afterConfigure?.hidden) {
	throw new Error('test setup assumption broken, expected managed:1 hidden:0 before the hidden/managed test: ' + JSON.stringify(afterConfigure))
}
r = await agentApi.agentConfigureHandler(canInstallSvc, 'agentic-svc', configureReq({ display: 'still-new', hidden: true, managed: false }))
if (r.status !== 200) throw new Error('configure with hidden/managed in the body must still succeed (fields silently ignored), got ' + r.status)
const afterHiddenManaged = db.getService('agentic-svc')
if (afterHiddenManaged?.hidden) throw new Error('agent-scoped configure must not set hidden: ' + JSON.stringify(afterHiddenManaged))
if (!afterHiddenManaged?.managed) throw new Error('agent-scoped configure must not set managed: ' + JSON.stringify(afterHiddenManaged))
if (afterHiddenManaged?.display !== 'still-new') throw new Error('display must still apply alongside the ignored hidden/managed: ' + JSON.stringify(afterHiddenManaged))

// --- Regression: installHandler/updateHandler (dashboard path, no opts) unchanged ---
const ctx = (grants: Record<string, boolean>) => ({ accessToken: 't', user: { id: '1', email: 'e@x', name: 'n' }, grants })
const register = { 'services.register': true }

// installHandler: validation is reached and group_name would come straight from the body
// (never forced) — the dashboard path keeps today's shape through the extraction.
const badInstall = await services.installHandler(
	ctx({ 'services.install': true }),
	new Request('http://x/services', {
		method: 'POST',
		body: JSON.stringify({ name: 'dash-svc', program: '/no/such/program-zz', group_name: 'whatever-the-caller-wants' }),
	}),
)
if (badInstall.status !== 422) throw new Error('dashboard install validation must be unchanged, got ' + badInstall.status)

// updateHandler: permission gate unchanged
const deniedUpdate = await services.updateHandler(ctx({}), 'dash-svc', new Request('http://x/services/dash-svc', { method: 'PATCH', body: '{}' }))
if (deniedUpdate.status !== 403) throw new Error('update without services.register must be 403, got ' + deniedUpdate.status)

// updateHandler: not-found unchanged (no row, not a live NSSM service)
const missingUpdate = await services.updateHandler(ctx(register), 'warden-smoke-agent-install-missing', new Request('http://x/services/x', { method: 'PATCH', body: '{}' }))
if (missingUpdate.status !== 404) throw new Error('update on an unknown service must be 404, got ' + missingUpdate.status)

// updateHandler: no opts means group_name stays freely settable, unlike the agent-scoped path above
db.upsertService('dash-svc', { group_name: 'original-group', managed: true })
const freeUpdate = await services.updateHandler(
	ctx(register),
	'dash-svc',
	new Request('http://x/services/dash-svc', { method: 'PATCH', body: JSON.stringify({ group_name: 'moved-group' }) }),
)
if (freeUpdate.status !== 200) throw new Error('dashboard update must succeed, got ' + freeUpdate.status)
const movedRow = db.getService('dash-svc')
if (movedRow?.group_name !== 'moved-group') throw new Error('dashboard update must freely set group_name (no requireGroupName pin): ' + movedRow?.group_name)

// updateHandler: hidden/managed stay settable on the dashboard path — the agentScoped
// restriction above applies only to the agent-gated configure path, never to this one.
const hiddenManagedUpdate = await services.updateHandler(
	ctx(register),
	'dash-svc',
	new Request('http://x/services/dash-svc', { method: 'PATCH', body: JSON.stringify({ hidden: true, managed: false }) }),
)
if (hiddenManagedUpdate.status !== 200) throw new Error('dashboard update with hidden/managed must succeed, got ' + hiddenManagedUpdate.status)
const hiddenManagedRow = db.getService('dash-svc')
if (!hiddenManagedRow?.hidden) throw new Error('dashboard update must still be able to set hidden: ' + JSON.stringify(hiddenManagedRow))
if (hiddenManagedRow?.managed) throw new Error('dashboard update must still be able to set managed: ' + JSON.stringify(hiddenManagedRow))

console.log('smoke-agent-install ok')
process.exit(0)
