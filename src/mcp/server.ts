import pkg from '../../package.json'
import { auditLog } from '../auth/agentAudit'
import { type AgentToken } from '../auth/agentTokens'
import { findTool, MCP_TOOLS } from './tools'

// Minimal MCP server over Streamable HTTP: one JSON-RPC message per POST, answered with a
// single application/json response. Stateless (no Mcp-Session-Id), no server-initiated SSE
// stream, no batching. Implements initialize, ping, tools/list and tools/call; the caller is
// already authenticated by agentAuthMiddleware, exactly as for /v1.
//
// Audit: tool calls are audited by the /v1 handlers they delegate to. This layer audits
// initialize (once per connection), tools/list (schema enumeration), and every rejected
// envelope, method, or tool name (probing). ping and notifications are not audited: they
// carry no capability and would be per-connection keepalive noise.

// Newest first; an unsupported requested version is answered with the newest, per the spec.
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'] as const

// Keys double as the audit result for a rejected call
export const RPC_ERROR = {
	parse_error: -32700,
	invalid_request: -32600,
	method_not_found: -32601,
	invalid_params: -32602,
} as const

type RpcErrorKind = keyof typeof RPC_ERROR

type RpcId = string | number

const DETAIL_MAX = 100

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function rpcResult(id: RpcId, result: unknown): Response {
	return Response.json({ jsonrpc: '2.0', id, result })
}

// Every JSON-RPC error is audited, so enumerating methods or tool names leaves a trace.
// detail is caller-supplied (method or tool name), so it is length-capped.
function rpcError(caller: AgentToken, id: RpcId | null, kind: RpcErrorKind, message: string, status = 200, detail?: string): Response {
	auditLog({ token: caller.name, action: 'rpc_error', service: null, ...(detail === undefined ? {} : { detail: detail.slice(0, DETAIL_MAX) }), result: kind, status })
	return Response.json({ jsonrpc: '2.0', id, error: { code: RPC_ERROR[kind], message } }, { status })
}

export function negotiateProtocolVersion(requested: unknown): string {
	const supported: readonly string[] = SUPPORTED_PROTOCOL_VERSIONS
	return typeof requested === 'string' && supported.includes(requested) ? requested : supported[0]!
}

// A handler Response becomes a tool result; an HTTP error status is a tool-level error
// (isError), not a JSON-RPC error, so the caller sees the same message /v1 would return.
async function toolResult(response: Response): Promise<Record<string, unknown>> {
	return { content: [{ type: 'text', text: await response.text() }], isError: !response.ok }
}

async function callTool(caller: AgentToken, id: RpcId, params: unknown): Promise<Response> {
	if (!isObject(params) || typeof params.name !== 'string') {
		return rpcError(caller, id, 'invalid_params', 'tools/call requires params.name', 200, 'tools/call')
	}
	const args = params.arguments ?? {}
	if (!isObject(args)) return rpcError(caller, id, 'invalid_params', 'tools/call params.arguments must be an object', 200, params.name)

	const tool = findTool(params.name)
	if (!tool) return rpcError(caller, id, 'invalid_params', `Unknown tool: ${params.name}`, 200, params.name)

	return rpcResult(id, await toolResult(await tool.call(caller, args)))
}

export async function mcpHandler(caller: AgentToken, req: Request): Promise<Response> {
	let msg: unknown
	try {
		msg = await req.json()
	} catch {
		return rpcError(caller, null, 'parse_error', 'Parse error', 400)
	}

	if (!isObject(msg) || msg.jsonrpc !== '2.0') {
		return rpcError(caller, null, 'invalid_request', 'Expected a single JSON-RPC 2.0 message', 400)
	}

	// Notifications (no id) and client responses (no method) need no reply
	const isNotification = msg.id === undefined && typeof msg.method === 'string'
	const isClientResponse = msg.method === undefined && ('result' in msg || 'error' in msg)
	if (isNotification || isClientResponse) {
		return new Response(null, { status: 202 })
	}

	const id = msg.id
	if ((typeof id !== 'string' && typeof id !== 'number') || typeof msg.method !== 'string') {
		return rpcError(caller, null, 'invalid_request', 'Invalid JSON-RPC request', 400)
	}

	switch (msg.method) {
		case 'initialize': {
			const params = isObject(msg.params) ? msg.params : {}
			auditLog({ token: caller.name, action: 'initialize', service: null, result: 'ok', status: 200 })
			return rpcResult(id, {
				protocolVersion: negotiateProtocolVersion(params.protocolVersion),
				capabilities: { tools: {} },
				serverInfo: { name: 'warden', version: pkg.version },
			})
		}
		case 'ping':
			return rpcResult(id, {})
		case 'tools/list':
			auditLog({ token: caller.name, action: 'tools_list', service: null, result: 'ok', status: 200 })
			return rpcResult(id, { tools: MCP_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) })
		case 'tools/call':
			return callTool(caller, id, msg.params)
		default:
			return rpcError(caller, id, 'method_not_found', `Method not found: ${msg.method}`, 200, msg.method)
	}
}
