// The shape of the GraphQL schema table, the helpers that build repetitive parts of it
// (connections, edges), and Relay-style cursor paging over an in-memory list.

export type Args = Record<string, any>;
export type Resolver = (source: any, args: Args) => unknown;

export interface FieldDef {
  /** GraphQL type notation: `String!`, `[Issue!]!`, `IssueConnection!`. */
  type: string;
  args?: Record<string, string>;
  resolve?: Resolver;
}

export interface TypeDef {
  kind: 'OBJECT' | 'INTERFACE' | 'UNION' | 'ENUM' | 'INPUT_OBJECT' | 'SCALAR';
  description?: string;
  fields?: Record<string, FieldDef>;
  interfaces?: string[];
  /** The object types of a union or the implementers of an interface. */
  possible?: string[];
  values?: string[];
  inputFields?: Record<string, string>;
}

export type Schema = Record<string, TypeDef>;

/** A value tagged with its GraphQL object type, for fields typed as an interface or union. */
export interface Typed {
  __type: string;
}

export interface Connection<T> {
  nodes: T[];
  edges: { node: T; cursor: string }[];
  totalCount: number;
  pageInfo: { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null };
}

function cursorOf(index: number): string {
  return Buffer.from(`cursor:v2:${index}`, 'utf8').toString('base64');
}

function indexOf(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  const match = /^cursor:v2:(\d+)$/.exec(Buffer.from(cursor, 'base64').toString('utf8'));
  return match === null ? null : Number(match[1]);
}

/** Slice `items` the way a connection's first/after/last/before arguments ask. */
export function connection<T>(items: T[], args: Args): Connection<T> {
  let from = 0;
  let to = items.length;
  const after = indexOf(args.after);
  const before = indexOf(args.before);
  if (after !== null) from = Math.min(items.length, after + 1);
  if (before !== null) to = Math.max(from, Math.min(to, before));
  if (typeof args.first === 'number') to = Math.min(to, from + Math.max(0, args.first));
  else if (typeof args.last === 'number') from = Math.max(from, to - Math.max(0, args.last));
  else to = Math.min(to, from + 100);
  const edges = [];
  for (let index = from; index < to; index += 1) edges.push({ node: items[index]!, cursor: cursorOf(index) });
  return {
    nodes: edges.map((edge) => edge.node),
    edges,
    totalCount: items.length,
    pageInfo: {
      hasNextPage: to < items.length,
      hasPreviousPage: from > 0,
      startCursor: edges.length > 0 ? edges[0]!.cursor : null,
      endCursor: edges.length > 0 ? edges[edges.length - 1]!.cursor : null,
    },
  };
}

/** Add `<Name>Connection` and `<Name>Edge` for a node type to the schema. */
export function addConnection(schema: Schema, node: string, extra: Record<string, FieldDef> = {}): void {
  schema[`${node}Edge`] = {
    kind: 'OBJECT',
    fields: { cursor: { type: 'String!' }, node: { type: node } },
  };
  schema[`${node}Connection`] = {
    kind: 'OBJECT',
    fields: {
      edges: { type: `[${node}Edge]` },
      nodes: { type: `[${node}]` },
      pageInfo: { type: 'PageInfo!' },
      totalCount: { type: 'Int!' },
      ...extra,
    },
  };
}

export const PAGING: Record<string, string> = { first: 'Int', after: 'String', last: 'Int', before: 'String' };
