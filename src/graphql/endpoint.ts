// POST /api/graphql: one operation as a JSON object, or several as a JSON array answered in
// the same order.

import { execute, type GraphQLResult } from './execute.ts';

export interface GraphQLReply {
  status: number;
  body: Buffer;
}

function one(entry: unknown): GraphQLResult {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return { errors: [{ message: 'A query attribute must be specified and must be a string.' }] };
  }
  const request = entry as { query?: unknown; variables?: unknown; operationName?: unknown };
  let variables = request.variables;
  if (typeof variables === 'string' && variables.trim() !== '') {
    try {
      variables = JSON.parse(variables);
    } catch {
      return { errors: [{ message: 'Variables must be a JSON object.' }] };
    }
  }
  try {
    return execute(request.query, variables, request.operationName);
  } catch (err) {
    process.stderr.write(`[forge] graphql failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    return { errors: [{ message: 'Something went wrong while executing your query.' }] };
  }
}

export function graphql(raw: Buffer): GraphQLReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return { status: 400, body: Buffer.from(JSON.stringify({ message: 'Problems parsing JSON', documentation_url: 'https://docs.github.com/graphql' }), 'utf8') };
  }
  const result = Array.isArray(parsed) ? parsed.map(one) : one(parsed);
  return { status: 200, body: Buffer.from(JSON.stringify(result), 'utf8') };
}
