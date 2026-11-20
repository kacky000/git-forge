// A GraphQL document parser: operations, fragments, selections, arguments and values. It
// covers the query language (not the schema definition language), which is all a server reads.

export type Value =
  | { k: 'var'; name: string }
  | { k: 'scalar'; v: string | number | boolean | null }
  | { k: 'enum'; v: string }
  | { k: 'list'; items: Value[] }
  | { k: 'object'; fields: [string, Value][] };

export interface Directive {
  name: string;
  args: [string, Value][];
}

export interface FieldNode {
  kind: 'field';
  alias: string;
  name: string;
  args: [string, Value][];
  directives: Directive[];
  selections: Selection[] | null;
}

export interface SpreadNode {
  kind: 'spread';
  name: string;
  directives: Directive[];
}

export interface InlineNode {
  kind: 'inline';
  on: string | null;
  directives: Directive[];
  selections: Selection[];
}

export type Selection = FieldNode | SpreadNode | InlineNode;

export interface VariableDef {
  name: string;
  type: string;
  fallback: Value | undefined;
}

export interface Operation {
  kind: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variables: VariableDef[];
  selections: Selection[];
}

export interface Fragment {
  name: string;
  on: string;
  selections: Selection[];
}

export interface Document {
  operations: Operation[];
  fragments: Map<string, Fragment>;
}

export class SyntaxError extends Error {}

interface Token {
  t: 'punct' | 'name' | 'int' | 'float' | 'string' | 'eof';
  v: string;
  at: number;
}

const NAME_START = /[_A-Za-z]/;
const NAME_PART = /[_0-9A-Za-z]/;

function lex(source: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i += 1;
    } else if (c === '#') {
      while (i < n && source[i] !== '\n') i += 1;
    } else if (c === '.' && source.startsWith('...', i)) {
      out.push({ t: 'punct', v: '...', at: i });
      i += 3;
    } else if ('!$()[]{}:=@|&'.includes(c)) {
      out.push({ t: 'punct', v: c, at: i });
      i += 1;
    } else if (NAME_START.test(c)) {
      let j = i + 1;
      while (j < n && NAME_PART.test(source[j]!)) j += 1;
      out.push({ t: 'name', v: source.slice(i, j), at: i });
      i = j;
    } else if (c === '-' || (c >= '0' && c <= '9')) {
      let j = i + 1;
      while (j < n && source[j]! >= '0' && source[j]! <= '9') j += 1;
      let float = false;
      if (source[j] === '.') {
        float = true;
        j += 1;
        while (j < n && source[j]! >= '0' && source[j]! <= '9') j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        float = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < n && source[j]! >= '0' && source[j]! <= '9') j += 1;
      }
      out.push({ t: float ? 'float' : 'int', v: source.slice(i, j), at: i });
      i = j;
    } else if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new SyntaxError('Unterminated block string');
        out.push({ t: 'string', v: source.slice(i + 3, end).replace(/\\"""/g, '"""').trim(), at: i });
        i = end + 3;
      } else {
        let j = i + 1;
        let text = '';
        for (;;) {
          if (j >= n || source[j] === '\n') throw new SyntaxError('Unterminated string');
          const d = source[j]!;
          if (d === '"') break;
          if (d === '\\') {
            const e = source[j + 1];
            if (e === 'u') {
              text += String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16));
              j += 6;
            } else {
              text += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e === 'b' ? '\b' : e === 'f' ? '\f' : e ?? '';
              j += 2;
            }
          } else {
            text += d;
            j += 1;
          }
        }
        out.push({ t: 'string', v: text, at: i });
        i = j + 1;
      }
    } else {
      throw new SyntaxError(`Unexpected character ${JSON.stringify(c)} at position ${i}`);
    }
  }
  out.push({ t: 'eof', v: '', at: n });
  return out;
}

export function parse(source: string): Document {
  const tokens = lex(source);
  let pos = 0;
  const peek = (): Token => tokens[pos]!;
  const isPunct = (v: string): boolean => peek().t === 'punct' && peek().v === v;
  const fail = (what: string): never => {
    const token = peek();
    throw new SyntaxError(`Parse error on ${token.t === 'eof' ? 'end of document' : JSON.stringify(token.v)} at position ${token.at}: expected ${what}`);
  };
  const eat = (v: string): void => {
    if (!isPunct(v)) fail(JSON.stringify(v));
    pos += 1;
  };
  const name = (): string => {
    const token = peek();
    if (token.t !== 'name') fail('a name');
    pos += 1;
    return token.v;
  };

  const value = (): Value => {
    const token = peek();
    if (token.t === 'punct') {
      if (token.v === '$') {
        pos += 1;
        return { k: 'var', name: name() };
      }
      if (token.v === '[') {
        pos += 1;
        const items: Value[] = [];
        while (!isPunct(']')) items.push(value());
        pos += 1;
        return { k: 'list', items };
      }
      if (token.v === '{') {
        pos += 1;
        const fields: [string, Value][] = [];
        while (!isPunct('}')) {
          const key = name();
          eat(':');
          fields.push([key, value()]);
        }
        pos += 1;
        return { k: 'object', fields };
      }
      return fail('a value');
    }
    pos += 1;
    if (token.t === 'int' || token.t === 'float') return { k: 'scalar', v: Number(token.v) };
    if (token.t === 'string') return { k: 'scalar', v: token.v };
    if (token.t === 'name') {
      if (token.v === 'true') return { k: 'scalar', v: true };
      if (token.v === 'false') return { k: 'scalar', v: false };
      if (token.v === 'null') return { k: 'scalar', v: null };
      return { k: 'enum', v: token.v };
    }
    pos -= 1;
    return fail('a value');
  };

  const args = (): [string, Value][] => {
    const out: [string, Value][] = [];
    if (!isPunct('(')) return out;
    pos += 1;
    while (!isPunct(')')) {
      const key = name();
      eat(':');
      out.push([key, value()]);
    }
    pos += 1;
    return out;
  };

  const directives = (): Directive[] => {
    const out: Directive[] = [];
    while (isPunct('@')) {
      pos += 1;
      out.push({ name: name(), args: args() });
    }
    return out;
  };

  const typeRef = (): string => {
    let text: string;
    if (isPunct('[')) {
      pos += 1;
      text = `[${typeRef()}]`;
      eat(']');
    } else text = name();
    if (isPunct('!')) {
      pos += 1;
      text += '!';
    }
    return text;
  };

  const selectionSet = (): Selection[] => {
    eat('{');
    const out: Selection[] = [];
    while (!isPunct('}')) {
      if (isPunct('...')) {
        pos += 1;
        const token = peek();
        if (token.t === 'name' && token.v !== 'on') {
          pos += 1;
          out.push({ kind: 'spread', name: token.v, directives: directives() });
        } else {
          let on: string | null = null;
          if (token.t === 'name') {
            pos += 1;
            on = name();
          }
          const marks = directives();
          out.push({ kind: 'inline', on, directives: marks, selections: selectionSet() });
        }
        continue;
      }
      let alias = name();
      let field = alias;
      if (isPunct(':')) {
        pos += 1;
        field = name();
      } else alias = field;
      const fieldArgs = args();
      const marks = directives();
      out.push({ kind: 'field', alias, name: field, args: fieldArgs, directives: marks, selections: isPunct('{') ? selectionSet() : null });
    }
    pos += 1;
    if (out.length === 0) fail('a selection');
    return out;
  };

  const doc: Document = { operations: [], fragments: new Map() };
  while (peek().t !== 'eof') {
    if (isPunct('{')) {
      doc.operations.push({ kind: 'query', name: null, variables: [], selections: selectionSet() });
      continue;
    }
    const word = name();
    if (word === 'fragment') {
      const fragmentName = name();
      if (name() !== 'on') fail('"on"');
      const on = name();
      directives();
      doc.fragments.set(fragmentName, { name: fragmentName, on, selections: selectionSet() });
      continue;
    }
    if (word !== 'query' && word !== 'mutation' && word !== 'subscription') fail('query, mutation, subscription or fragment');
    const op: Operation = { kind: word as Operation['kind'], name: null, variables: [], selections: [] };
    if (peek().t === 'name') op.name = name();
    if (isPunct('(')) {
      pos += 1;
      while (!isPunct(')')) {
        eat('$');
        const variable = name();
        eat(':');
        const type = typeRef();
        let fallback: Value | undefined;
        if (isPunct('=')) {
          pos += 1;
          fallback = value();
        }
        directives();
        op.variables.push({ name: variable, type, fallback });
      }
      pos += 1;
    }
    directives();
    op.selections = selectionSet();
    doc.operations.push(op);
  }
  if (doc.operations.length === 0) throw new SyntaxError('The document holds no operation');
  return doc;
}
