// POST /mcp: JSON-RPC 2.0 over the Streamable HTTP transport, answered as plain JSON.
//
// Both protocol eras are served by the same stateless handler: `server/discover` for
// 2026-07-28 clients, and `initialize` + `notifications/initialized` for earlier ones. No
// session is kept, so every request stands on its own.

import type { IncomingHttpHeaders } from 'node:http';
import { ApiError, isObject, type Json } from '../core/errors.ts';
import { TOOLS, TOOL_BY_NAME } from './tools.ts';

export interface McpReply {
  status: number;
  headers: Record<string, string>;
  body: Buffer | null;
}

const LATEST = '2026-07-28';
const VERSIONS = [LATEST, '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'git-forge', title: 'git-forge MCP server', version: '1.0.0' };
const CAPABILITIES = { tools: { listChanged: false } };
const INSTRUCTIONS = 'Tools for the repositories, issues and pull requests of this forge. Every tool acts as the account the bearer token belongs to.';

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

/** tools/list never changes, so it is rendered once: two calls answer the same bytes. */
const TOOL_LIST = TOOLS.map((tool) => ({
  name: tool.name,
  title: tool.title,
  description: tool.description,
  inputSchema: tool.inputSchema,
  annotations: tool.annotations,
}));

type Id = string | number | null;

function failure(id: Id, code: number, message: string, data?: unknown): Json {
  const error: Json = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

function success(id: Id, result: unknown): Json {
  return { jsonrpc: '2.0', id, result };
}

function toolResult(value: unknown): Json {
  const out: Json = { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false };
  if (isObject(value)) out.structuredContent = value;
  return out;
}

function toolFailure(message: string): Json {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function callTool(id: Id, params: Json): Json {
  const name = params.name;
  if (typeof name !== 'string' || name === '') return failure(id, INVALID_PARAMS, 'tools/call needs a tool name');
  const tool = TOOL_BY_NAME.get(name);
  if (tool === undefined) return failure(id, INVALID_PARAMS, `Unknown tool: ${name}`);
  const given = params.arguments;
  if (given !== undefined && given !== null && !isObject(given)) return failure(id, INVALID_PARAMS, 'tools/call arguments must be an object');
  const args: Json = isObject(given) ? given : {};
  const missing = tool.inputSchema.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
  if (missing.length > 0) return success(id, toolFailure(`missing required parameter${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`));
  try {
    return success(id, toolResult(tool.run(args)));
  } catch (err) {
    if (err instanceof ApiError) {
      const detail = err.errors === undefined ? '' : ` ${JSON.stringify(err.errors)}`;
      return success(id, toolFailure(`${name} failed: ${err.status} ${err.message}${detail}`));
    }
    process.stderr.write(`[forge] tool ${name} failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    return success(id, toolFailure(`${name} failed: internal error`));
  }
}

/** Answer one JSON-RPC message; null for a notification, which gets no response. */
function answer(message: unknown): Json | null {
  if (!isObject(message)) return failure(null, INVALID_REQUEST, 'Invalid Request');
  const rawId = message.id;
  const id: Id = typeof rawId === 'string' || typeof rawId === 'number' ? rawId : null;
  const method = message.method;
  if (typeof method !== 'string') {
    // A response sent to the server (or junk): nothing to answer unless it claims an id.
    if (message.result !== undefined || message.error !== undefined) return null;
    return failure(id, INVALID_REQUEST, 'Invalid Request');
  }
  if (rawId === undefined || rawId === null) return null;
  const params: Json = isObject(message.params) ? message.params : {};
  switch (method) {
    case 'server/discover':
      return success(id, {
        supportedVersions: VERSIONS,
        capabilities: CAPABILITIES,
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize': {
      const wanted = params.protocolVersion;
      const version = typeof wanted === 'string' && VERSIONS.includes(wanted) ? wanted : VERSIONS[1]!;
      return success(id, { protocolVersion: version, capabilities: CAPABILITIES, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS });
    }
    case 'ping':
      return success(id, {});
    case 'tools/list':
      return success(id, { tools: TOOL_LIST });
    case 'tools/call':
      return callTool(id, params);
    case 'resources/list':
      return success(id, { resources: [] });
    case 'resources/templates/list':
      return success(id, { resourceTemplates: [] });
    case 'prompts/list':
      return success(id, { prompts: [] });
    default:
      return failure(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

export function mcp(method: string, raw: Buffer, headers: IncomingHttpHeaders): McpReply {
  const base: Record<string, string> = { 'MCP-Protocol-Version': LATEST };
  const asked = headers['mcp-protocol-version'];
  if (typeof asked === 'string' && VERSIONS.includes(asked)) base['MCP-Protocol-Version'] = asked;
  if (method === 'DELETE') return { status: 204, headers: base, body: null };
  if (method !== 'POST') {
    return { status: 405, headers: { ...base, Allow: 'POST, DELETE' }, body: Buffer.from(JSON.stringify(failure(null, INVALID_REQUEST, 'This endpoint takes JSON-RPC over POST')), 'utf8') };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return { status: 400, headers: base, body: Buffer.from(JSON.stringify(failure(null, PARSE_ERROR, 'Parse error')), 'utf8') };
  }
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) return { status: 400, headers: base, body: Buffer.from(JSON.stringify(failure(null, INVALID_REQUEST, 'Invalid Request')), 'utf8') };
    const replies = parsed.map(answer).filter((reply): reply is Json => reply !== null);
    if (replies.length === 0) return { status: 202, headers: base, body: null };
    return { status: 200, headers: base, body: Buffer.from(JSON.stringify(replies), 'utf8') };
  }
  const reply = answer(parsed);
  if (reply === null) return { status: 202, headers: base, body: null };
  return { status: 200, headers: base, body: Buffer.from(JSON.stringify(reply), 'utf8') };
}
