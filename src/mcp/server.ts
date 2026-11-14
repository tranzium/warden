import pkg from '../../package.json'
import { type AgentToken } from '../auth/agentTokens'
import { findTool, MCP_TOOLS } from './tools'

// Minimal MCP server over Streamable HTTP: one JSON-RPC message per POST, answered with a
// single application/json response. Stateless (no Mcp-Session-Id), no server-initiated SSE
// stream, no batching. Implements initialize, ping, tools/list and tools/call; the caller is
// already authenticated by agentAuthMiddleware, exactly as for /v1.

// Newest first; an unsupported requested version is answered with the newest, per the spec.
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'] as const

export const RPC_ERROR = {
	parse: -32700,
	invalidRequest: -32600,
	methodNotFound: -32601,
	invalidParams: -32602,
} as const

type RpcId = string | number

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function rpcResult(id: RpcId, result: unknown): Response {
	return Response.json({ jsonrpc: '2.0', id, result })
}

function rpcError(id: RpcId | null, code: number, message: string, status = 200): Response {
	return Response.json({ jsonrpc: '2.0', id, error: { code, message } }, { status })
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
		return rpcError(id, RPC_ERROR.invalidParams, 'tools/call requires params.name')
	}
	const args = params.arguments ?? {}
	if (!isObject(args)) return rpcError(id, RPC_ERROR.invalidParams, 'tools/call params.arguments must be an object')

	const tool = findTool(params.name)
	if (!tool) return rpcError(id, RPC_ERROR.invalidParams, `Unknown tool: ${params.name}`)

	return rpcResult(id, await toolResult(await tool.call(caller, args)))
}

export async function mcpHandler(caller: AgentToken, req: Request): Promise<Response> {
	let msg: unknown
	try {
		msg = await req.json()
	} catch {
		return rpcError(null, RPC_ERROR.parse, 'Parse error', 400)
	}

	if (!isObject(msg) || msg.jsonrpc !== '2.0') {
		return rpcError(null, RPC_ERROR.invalidRequest, 'Expected a single JSON-RPC 2.0 message', 400)
	}

	// Notifications (no id) and client responses (no method) need no reply
	const isNotification = msg.id === undefined && typeof msg.method === 'string'
	const isClientResponse = msg.method === undefined && ('result' in msg || 'error' in msg)
	if (isNotification || isClientResponse) {
		return new Response(null, { status: 202 })
	}

	const id = msg.id
	if ((typeof id !== 'string' && typeof id !== 'number') || typeof msg.method !== 'string') {
		return rpcError(null, RPC_ERROR.invalidRequest, 'Invalid JSON-RPC request', 400)
	}

	switch (msg.method) {
		case 'initialize': {
			const params = isObject(msg.params) ? msg.params : {}
			return rpcResult(id, {
				protocolVersion: negotiateProtocolVersion(params.protocolVersion),
				capabilities: { tools: {} },
				serverInfo: { name: 'warden', version: pkg.version },
			})
		}
		case 'ping':
			return rpcResult(id, {})
		case 'tools/list':
			return rpcResult(id, { tools: MCP_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) })
		case 'tools/call':
			return callTool(caller, id, msg.params)
		default:
			return rpcError(id, RPC_ERROR.methodNotFound, `Method not found: ${msg.method}`)
	}
}
