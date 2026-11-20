// Validating and executing one GraphQL operation against the schema table.

import { ApiError } from '../core/errors.ts';
import { parse, SyntaxError, type Directive, type Document, type FieldNode, type Operation, type Selection, type Value } from './parse.ts';
import { schema } from './schema.ts';
import { installIntrospection } from './introspect.ts';
import type { FieldDef } from './types.ts';

installIntrospection(schema);

export interface GraphQLError {
  message: string;
  path?: (string | number)[];
  type?: string;
  extensions?: Record<string, unknown>;
}

export interface GraphQLResult {
  data?: unknown;
  errors?: GraphQLError[];
}

/** `[Issue!]!` -> `Issue`. */
function namedType(notation: string): string {
  return notation.replace(/[[\]!]/g, '');
}

function isComposite(name: string): boolean {
  const kind = schema[name]?.kind;
  return kind === 'OBJECT' || kind === 'INTERFACE' || kind === 'UNION';
}

function fieldOf(typeName: string, field: string): FieldDef | undefined {
  return schema[typeName]?.fields?.[field];
}

// ---------------------------------------------------------------- validation

function validate(doc: Document, op: Operation, rootType: string): GraphQLError[] {
  const errors: GraphQLError[] = [];
  const walking = new Set<string>();
  const walk = (selections: Selection[], typeName: string, path: string[]): void => {
    for (const selection of selections) {
      if (selection.kind === 'field') {
        if (selection.name === '__typename') continue;
        const def = fieldOf(typeName, selection.name);
        const here = [...path, selection.alias];
        if (def === undefined) {
          errors.push({
            message: `Field '${selection.name}' doesn't exist on type '${typeName}'`,
            path: here,
            extensions: { code: 'undefinedField', typeName, fieldName: selection.name },
          });
          continue;
        }
        for (const [arg] of selection.args) {
          if (def.args === undefined || !(arg in def.args)) {
            errors.push({
              message: `Field '${selection.name}' doesn't accept argument '${arg}'`,
              path: here,
              extensions: { code: 'argumentNotAccepted', name: selection.name, typeName: 'Field', argumentName: arg },
            });
          }
        }
        const inner = namedType(def.type);
        if (isComposite(inner)) {
          if (selection.selections === null) {
            errors.push({ message: `Field must have selections (field '${selection.name}' returns ${inner} but has no selections. Did you mean '${selection.name} { ... }'?)`, path: here, extensions: { code: 'selectionMismatch', nodeName: `field '${selection.name}'`, typeName: inner } });
          } else walk(selection.selections, inner, here);
        } else if (selection.selections !== null) {
          errors.push({ message: `Selections can't be made on scalars (field '${selection.name}' returns ${inner} but has selections)`, path: here, extensions: { code: 'selectionMismatch', nodeName: `field '${selection.name}'`, typeName: inner } });
        }
      } else if (selection.kind === 'inline') {
        const on = selection.on ?? typeName;
        if (schema[on] === undefined || !isComposite(on)) {
          errors.push({ message: `No such type ${on}, so it can't be a fragment condition`, path, extensions: { code: 'undefinedType', typeName: on } });
          continue;
        }
        walk(selection.selections, on, path);
      } else {
        const fragment = doc.fragments.get(selection.name);
        if (fragment === undefined) {
          errors.push({ message: `Fragment ${selection.name} was used, but not defined`, path, extensions: { code: 'useAndDefineFragment', fragmentName: selection.name } });
          continue;
        }
        if (schema[fragment.on] === undefined || !isComposite(fragment.on)) {
          errors.push({ message: `No such type ${fragment.on}, so it can't be a fragment condition`, path, extensions: { code: 'undefinedType', typeName: fragment.on } });
          continue;
        }
        if (walking.has(fragment.name)) continue;
        walking.add(fragment.name);
        walk(fragment.selections, fragment.on, path);
        walking.delete(fragment.name);
      }
    }
  };
  walk(op.selections, rootType, [op.kind + (op.name === null ? '' : ` ${op.name}`)]);
  return errors;
}

// ---------------------------------------------------------------- execution

interface Run {
  doc: Document;
  variables: Record<string, unknown>;
  errors: GraphQLError[];
}

function evaluate(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.k) {
    case 'var':
      return variables[value.name];
    case 'scalar':
    case 'enum':
      return value.v;
    case 'list':
      return value.items.map((item) => evaluate(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, item] of value.fields) out[key] = evaluate(item, variables);
      return out;
    }
  }
}

function included(directives: Directive[], variables: Record<string, unknown>): boolean {
  for (const directive of directives) {
    const condition = directive.args.find(([name]) => name === 'if');
    if (condition === undefined) continue;
    const on = evaluate(condition[1], variables) === true;
    if (directive.name === 'skip' && on) return false;
    if (directive.name === 'include' && !on) return false;
  }
  return true;
}

/** Whether a fragment written for `condition` applies to an object of type `typeName`. */
function applies(condition: string, typeName: string): boolean {
  if (condition === typeName) return true;
  const def = schema[condition];
  if (def?.possible?.includes(typeName) === true) return true;
  return schema[typeName]?.interfaces?.includes(condition) === true;
}

function complete(run: Run, value: unknown, notation: string, field: FieldNode, path: (string | number)[]): unknown {
  if (notation.endsWith('!')) return complete(run, value, notation.slice(0, -1), field, path);
  if (value === null || value === undefined) return null;
  if (notation.startsWith('[')) {
    if (!Array.isArray(value)) return null;
    const inner = notation.slice(1, -1);
    return value.map((item, index) => complete(run, item, inner, field, [...path, index]));
  }
  const def = schema[notation];
  if (def === undefined || def.kind === 'SCALAR' || def.kind === 'ENUM' || def.kind === 'INPUT_OBJECT') return value;
  let runtime = notation;
  if (def.kind !== 'OBJECT') {
    const tagged = (value as { __type?: unknown }).__type;
    runtime = typeof tagged === 'string' ? tagged : def.possible?.[0] ?? notation;
  }
  const out: Record<string, unknown> = {};
  select(run, field.selections ?? [], runtime, value, path, out);
  return out;
}

function select(run: Run, selections: Selection[], typeName: string, source: unknown, path: (string | number)[], out: Record<string, unknown>): void {
  for (const selection of selections) {
    if (!included(selection.directives, run.variables)) continue;
    if (selection.kind === 'inline') {
      if (selection.on === null || applies(selection.on, typeName)) select(run, selection.selections, typeName, source, path, out);
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = run.doc.fragments.get(selection.name);
      if (fragment !== undefined && applies(fragment.on, typeName)) select(run, fragment.selections, typeName, source, path, out);
      continue;
    }
    if (selection.name === '__typename') {
      out[selection.alias] = typeName;
      continue;
    }
    const def = fieldOf(typeName, selection.name);
    if (def === undefined) {
      // Valid on another member of the union or interface, absent on this one.
      continue;
    }
    const here = [...path, selection.alias];
    const args: Record<string, unknown> = {};
    for (const [name, value] of selection.args) args[name] = evaluate(value, run.variables);
    try {
      let value: unknown;
      if (def.resolve !== undefined) value = def.resolve(source, args);
      else {
        value = (source as Record<string, unknown> | null)?.[selection.name];
        if (typeof value === 'function') value = (value as (a: unknown) => unknown).call(source, args);
      }
      const done = complete(run, value, def.type, selection, here);
      const before = out[selection.alias];
      // The same field selected twice (directly and through a fragment) merges its children.
      if (before !== null && typeof before === 'object' && !Array.isArray(before) && done !== null && typeof done === 'object' && !Array.isArray(done)) Object.assign(before, done);
      else out[selection.alias] = done;
    } catch (err) {
      out[selection.alias] = null;
      if (err instanceof ApiError) {
        run.errors.push({ message: err.message, path: here, type: err.status === 404 ? 'NOT_FOUND' : err.status === 403 ? 'FORBIDDEN' : 'UNPROCESSABLE' });
      } else {
        process.stderr.write(`[forge] graphql resolver failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
        run.errors.push({ message: 'Something went wrong while executing your query.', path: here, type: 'INTERNAL' });
      }
    }
  }
}

/** Run one request: `{query, variables, operationName}` in, `{data, errors}` out. */
export function execute(query: unknown, variables: unknown, operationName: unknown): GraphQLResult {
  if (typeof query !== 'string' || query.trim() === '') return { errors: [{ message: 'A query attribute must be specified and must be a string.' }] };
  let doc: Document;
  try {
    doc = parse(query);
  } catch (err) {
    if (err instanceof SyntaxError) return { errors: [{ message: err.message, extensions: { code: 'parseError' } }] };
    throw err;
  }
  let op: Operation | undefined;
  if (typeof operationName === 'string' && operationName !== '') op = doc.operations.find((candidate) => candidate.name === operationName);
  else if (doc.operations.length === 1) op = doc.operations[0];
  if (op === undefined) {
    return { errors: [{ message: typeof operationName === 'string' && operationName !== '' ? `No operation named "${operationName}"` : 'An operation name is required' }] };
  }
  const rootType = op.kind === 'mutation' ? 'Mutation' : 'Query';
  if (op.kind === 'subscription') return { errors: [{ message: "Schema is not configured for subscriptions" }] };
  const problems = validate(doc, op, rootType);
  if (problems.length > 0) return { errors: problems };

  const given = typeof variables === 'object' && variables !== null && !Array.isArray(variables) ? (variables as Record<string, unknown>) : {};
  const values: Record<string, unknown> = {};
  const missing: GraphQLError[] = [];
  for (const def of op.variables) {
    let value = given[def.name];
    if (value === undefined && def.fallback !== undefined) value = evaluate(def.fallback, {});
    if ((value === undefined || value === null) && def.type.endsWith('!')) {
      missing.push({ message: `Variable $${def.name} of type ${def.type} was provided invalid value`, extensions: { value: value ?? null, problems: [{ path: [], explanation: 'Expected value to not be null' }] } });
    }
    values[def.name] = value;
  }
  if (missing.length > 0) return { errors: missing };

  const run: Run = { doc, variables: values, errors: [] };
  const data: Record<string, unknown> = {};
  select(run, op.selections, rootType, {}, [], data);
  return run.errors.length > 0 ? { data, errors: run.errors } : { data };
}
