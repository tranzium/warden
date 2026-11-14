import { auditLog } from '../auth/agentAudit'
import { type AgentToken } from '../auth/agentTokens'
import { agentConfigureHandler, agentInstallHandler, agentRestartHandler, agentStatusHandler, isAllowed } from '../routes/agentApi'
import { buildServices } from '../routes/services'
import { ok } from '../shared/http'

// MCP tool registry. Every tool is a thin wrapper over the same /v1 agent-api handlers (or, for
// list_services, buildServices() plus the same isAllowed check), so scoping, the hardcoded agentic
// group fence, dry-run-by-default, and audit logging are the /v1 code paths themselves, not copies.
// Tools return the handler's own Response; the JSON-RPC layer turns it into a tool result.

export type McpTool = {
	name: string
	description: string
	inputSchema: Record<string, unknown>
	call: (caller: AgentToken, args: Record<string, unknown>) => Promise<Response>
}

// Synthetic requests mirror the /v1 routes; the handlers only read the body and the live flag.
const BASE_URL = 'http://warden.mcp'

const nameSchema = { type: 'string', description: 'Service name, as provisioned on the calling token' }

// A non-string name becomes '' so the shared handlers refuse it (and audit the refusal) as /v1 does.
function nameArg(args: Record<string, unknown>): string {
	return typeof args.name === 'string' ? args.name : ''
}

function jsonRequest(path: string, method: string, body: Record<string, unknown>): Request {
	return new Request(BASE_URL + path, { method, body: JSON.stringify(body) })
}

// Only an explicit boolean true goes live; "true", 1, or an omitted live all stay dry-run.
export function restartUrl(name: string, live: unknown): string {
	return `${BASE_URL}/v1/services/${encodeURIComponent(name)}/restart${live === true ? '?live=1' : ''}`
}

export const MCP_TOOLS: readonly McpTool[] = [
	{
		name: 'list_services',
		description: 'List the services this token is allowlisted for, with display name, group, and current status.',
		inputSchema: { type: 'object', properties: {} },
		async call(caller) {
			const services = (await buildServices()).filter(s => isAllowed(caller, s.name))
			auditLog({ token: caller.name, action: 'list', service: null, result: 'ok', status: 200 })
			return ok({ services })
		},
	},
	{
		name: 'get_service_status',
		description: 'Get the current status of one allowlisted service.',
		inputSchema: { type: 'object', properties: { name: nameSchema }, required: ['name'] },
		call: (caller, args) => agentStatusHandler(caller, nameArg(args)),
	},
	{
		name: 'restart_service',
		description: 'Restart one allowlisted service. Dry-run by default: reports what would happen without touching the service. Pass live: true to actually restart.',
		inputSchema: {
			type: 'object',
			properties: {
				name: nameSchema,
				live: { type: 'boolean', description: 'true to actually restart; omitted or false is a dry run' },
			},
			required: ['name'],
		},
		call: (caller, args) => agentRestartHandler(caller, nameArg(args), new Request(restartUrl(nameArg(args), args.live), { method: 'POST' })),
	},
	{
		name: 'configure_service',
		description: "Update display name or description of a service already in the 'agentic' group. Requires an install-capable token allowlisted for the service; the group cannot be changed. managed and hidden are dashboard-only and are not accepted here.",
		inputSchema: {
			type: 'object',
			properties: {
				name: nameSchema,
				display: { type: ['string', 'null'] },
				description: { type: ['string', 'null'] },
			},
			required: ['name'],
		},
		call: (caller, args) => agentConfigureHandler(caller, nameArg(args), jsonRequest(`/v1/services/${encodeURIComponent(nameArg(args))}`, 'PATCH', args)),
	},
	{
		name: 'install_service',
		description: "Install a new NSSM service into the 'agentic' group. Requires an install-capable token allowlisted for the service name; the group is always 'agentic'.",
		inputSchema: {
			type: 'object',
			properties: {
				name: nameSchema,
				program: { type: 'string', description: 'Absolute path to the executable' },
				args: { type: 'string' },
				directory: { type: 'string' },
				display: { type: 'string' },
				description: { type: 'string' },
				start: { type: 'string', enum: ['auto', 'delayed', 'manual', 'disabled'] },
				env: { type: 'object', additionalProperties: { type: 'string' } },
				restartDelayMs: { type: 'integer', minimum: 0 },
				rotateBytes: { type: 'integer', minimum: 1 },
				stdout: { type: 'string' },
				stderr: { type: 'string' },
			},
			required: ['name', 'program'],
		},
		call: (caller, args) => agentInstallHandler(caller, jsonRequest('/v1/services', 'POST', args)),
	},
]

export function findTool(name: string): McpTool | undefined {
	return MCP_TOOLS.find(t => t.name === name)
}
