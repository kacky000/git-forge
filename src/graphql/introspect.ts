// Introspection: the schema table rendered as __Schema/__Type values, and the meta types that
// describe them, so `__type(name:)` and `__schema` resolve like any other field.

import type { FieldDef, Schema, TypeDef } from './types.ts';

interface IntroType {
  kind: string;
  name: string | null;
  description: string | null;
  fields: (() => unknown[]) | null;
  interfaces: (() => unknown[]) | null;
  possibleTypes: (() => unknown[]) | null;
  enumValues: (() => unknown[]) | null;
  inputFields: (() => unknown[]) | null;
  ofType: IntroType | null;
  specifiedByURL: null;
  isOneOf: boolean;
}

const META: Schema = {
  __TypeKind: { kind: 'ENUM', values: ['SCALAR', 'OBJECT', 'INTERFACE', 'UNION', 'ENUM', 'INPUT_OBJECT', 'LIST', 'NON_NULL'] },
  __DirectiveLocation: { kind: 'ENUM', values: ['QUERY', 'MUTATION', 'FIELD', 'FRAGMENT_SPREAD', 'INLINE_FRAGMENT'] },
  __Schema: {
    kind: 'OBJECT',
    fields: {
      description: { type: 'String' },
      types: { type: '[__Type!]!' },
      queryType: { type: '__Type!' },
      mutationType: { type: '__Type' },
      subscriptionType: { type: '__Type' },
      directives: { type: '[__Directive!]!' },
    },
  },
  __Type: {
    kind: 'OBJECT',
    fields: {
      kind: { type: '__TypeKind!' },
      name: { type: 'String' },
      description: { type: 'String' },
      specifiedByURL: { type: 'String' },
      fields: { type: '[__Field!]', args: { includeDeprecated: 'Boolean' } },
      interfaces: { type: '[__Type!]' },
      possibleTypes: { type: '[__Type!]' },
      enumValues: { type: '[__EnumValue!]', args: { includeDeprecated: 'Boolean' } },
      inputFields: { type: '[__InputValue!]', args: { includeDeprecated: 'Boolean' } },
      ofType: { type: '__Type' },
      isOneOf: { type: 'Boolean' },
    },
  },
  __Field: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String!' },
      description: { type: 'String' },
      args: { type: '[__InputValue!]!', args: { includeDeprecated: 'Boolean' } },
      type: { type: '__Type!' },
      isDeprecated: { type: 'Boolean!' },
      deprecationReason: { type: 'String' },
    },
  },
  __InputValue: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String!' },
      description: { type: 'String' },
      type: { type: '__Type!' },
      defaultValue: { type: 'String' },
      isDeprecated: { type: 'Boolean!' },
      deprecationReason: { type: 'String' },
    },
  },
  __EnumValue: {
    kind: 'OBJECT',
    fields: { name: { type: 'String!' }, description: { type: 'String' }, isDeprecated: { type: 'Boolean!' }, deprecationReason: { type: 'String' } },
  },
  __Directive: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String!' },
      description: { type: 'String' },
      locations: { type: '[__DirectiveLocation!]!' },
      args: { type: '[__InputValue!]!', args: { includeDeprecated: 'Boolean' } },
      isRepeatable: { type: 'Boolean!' },
    },
  },
};

/** Add the meta types and the two meta fields to `schema`, and return its introspection view. */
export function installIntrospection(schema: Schema): void {
  Object.assign(schema, META);
  const named = new Map<string, IntroType>();

  const wrap = (kind: string, of: IntroType): IntroType => ({
    kind,
    name: null,
    description: null,
    fields: null,
    interfaces: null,
    possibleTypes: null,
    enumValues: null,
    inputFields: null,
    ofType: of,
    specifiedByURL: null,
    isOneOf: false,
  });

  const refOf = (notation: string): IntroType => {
    if (notation.endsWith('!')) return wrap('NON_NULL', refOf(notation.slice(0, -1)));
    if (notation.startsWith('[')) return wrap('LIST', refOf(notation.slice(1, -1)));
    const hit = named.get(notation);
    if (hit === undefined) throw new Error(`the schema names an unknown type ${notation}`);
    return hit;
  };

  const inputValue = (name: string, notation: string): unknown => ({
    name,
    description: null,
    type: refOf(notation),
    defaultValue: null,
    isDeprecated: false,
    deprecationReason: null,
  });

  const fieldValue = (name: string, def: FieldDef): unknown => ({
    name,
    description: null,
    args: Object.entries(def.args ?? {}).map(([arg, notation]) => inputValue(arg, notation)),
    type: refOf(def.type),
    isDeprecated: false,
    deprecationReason: null,
  });

  const build = (name: string, def: TypeDef): IntroType => {
    const composite = def.kind === 'OBJECT' || def.kind === 'INTERFACE';
    const abstract = def.kind === 'INTERFACE' || def.kind === 'UNION';
    return {
      kind: def.kind,
      name,
      description: def.description ?? null,
      fields: composite
        ? () => Object.entries(def.fields ?? {}).filter(([field]) => !field.startsWith('__')).map(([field, fieldDef]) => fieldValue(field, fieldDef))
        : null,
      interfaces: composite ? () => (def.interfaces ?? []).map((item) => refOf(item)) : null,
      possibleTypes: abstract ? () => (def.possible ?? []).map((item) => refOf(item)) : null,
      enumValues: def.kind === 'ENUM' ? () => (def.values ?? []).map((value) => ({ name: value, description: null, isDeprecated: false, deprecationReason: null })) : null,
      inputFields: def.kind === 'INPUT_OBJECT' ? () => Object.entries(def.inputFields ?? {}).map(([field, notation]) => inputValue(field, notation)) : null,
      ofType: null,
      specifiedByURL: null,
      isOneOf: false,
    };
  };

  for (const [name, def] of Object.entries(schema)) named.set(name, build(name, def));

  const root = {
    description: null,
    types: [...named.values()],
    queryType: named.get('Query')!,
    mutationType: named.get('Mutation') ?? null,
    subscriptionType: null,
    directives: [
      { name: 'include', description: null, locations: ['FIELD', 'FRAGMENT_SPREAD', 'INLINE_FRAGMENT'], args: [inputValue('if', 'Boolean!')], isRepeatable: false },
      { name: 'skip', description: null, locations: ['FIELD', 'FRAGMENT_SPREAD', 'INLINE_FRAGMENT'], args: [inputValue('if', 'Boolean!')], isRepeatable: false },
    ],
  };

  const query = schema.Query!;
  query.fields!.__schema = { type: '__Schema!', resolve: () => root };
  query.fields!.__type = { type: '__Type', args: { name: 'String!' }, resolve: (_source, args) => named.get(String(args.name)) ?? null };
}
