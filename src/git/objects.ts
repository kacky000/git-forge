// The object database: every commit, tree, blob and tag the forge knows, keyed by SHA-1.
//
// Objects are content addressed, so one map serves every repository: a repository is only a set
// of refs pointing into it. Parsed views (commit headers, tree entries) are cached on the object.

import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export interface GitObj {
  type: ObjType;
  data: Buffer;
  /** zlib-deflated `data`, kept so a pack can be assembled without compressing again. */
  z?: Buffer;
  commit?: CommitInfo;
  entries?: TreeEntry[];
  tagInfo?: TagInfo;
}

export const ZERO = '0000000000000000000000000000000000000000';
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const db = new Map<string, GitObj>();

export function hashOf(type: ObjType, data: Buffer): string {
  const h = createHash('sha1');
  h.update(`${type} ${data.length}\0`);
  h.update(data);
  return h.digest('hex');
}

/** Store an object (a no-op when it is already known) and return its id. */
export function putObject(type: ObjType, data: Buffer, z?: Buffer): string {
  const oid = hashOf(type, data);
  const known = db.get(oid);
  if (known === undefined) db.set(oid, z === undefined ? { type, data } : { type, data, z });
  else if (known.z === undefined && z !== undefined) known.z = z;
  return oid;
}

export function getObject(oid: string): GitObj | undefined {
  return db.get(oid);
}

export function hasObject(oid: string): boolean {
  return db.has(oid);
}

export function needObject(oid: string): GitObj {
  const obj = db.get(oid);
  if (obj === undefined) throw new Error(`missing object ${oid}`);
  return obj;
}

export function deflated(obj: GitObj): Buffer {
  if (obj.z === undefined) obj.z = deflateSync(obj.data);
  return obj.z;
}

// ---------------------------------------------------------------- trees

export function treeEntries(oid: string): TreeEntry[] {
  const obj = needObject(oid);
  if (obj.type !== 'tree') throw new Error(`${oid} is a ${obj.type}, not a tree`);
  if (obj.entries !== undefined) return obj.entries;
  const data = obj.data;
  const out: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) throw new Error(`malformed tree ${oid}`);
    out.push({
      mode: data.toString('latin1', pos, space),
      name: data.toString('utf8', space + 1, nul),
      oid: data.toString('hex', nul + 1, nul + 21),
    });
    pos = nul + 21;
  }
  obj.entries = out;
  return out;
}

export function isDirMode(mode: string): boolean {
  return mode === '40000' || mode === '040000';
}

/** git orders tree entries by name, with a directory compared as if its name ended in '/'. */
function sortKey(entry: TreeEntry): Buffer {
  return Buffer.from(isDirMode(entry.mode) ? `${entry.name}/` : entry.name, 'utf8');
}

export function writeTree(entries: TreeEntry[]): string {
  const sorted = entries.slice().sort((a, b) => Buffer.compare(sortKey(a), sortKey(b)));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${isDirMode(entry.mode) ? '40000' : entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return putObject('tree', Buffer.concat(parts));
}

// ---------------------------------------------------------------- commits and tags

function splitHeaders(data: Buffer): { headers: [string, string][]; message: string } {
  const text = data.toString('utf8');
  const cut = text.indexOf('\n\n');
  const head = cut < 0 ? text : text.slice(0, cut);
  const message = cut < 0 ? '' : text.slice(cut + 2);
  const headers: [string, string][] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith(' ')) {
      const last = headers[headers.length - 1];
      if (last !== undefined) last[1] += `\n${line.slice(1)}`;
      continue;
    }
    const space = line.indexOf(' ');
    if (space > 0) headers.push([line.slice(0, space), line.slice(space + 1)]);
  }
  return { headers, message };
}

export function commitInfo(oid: string): CommitInfo {
  const obj = needObject(oid);
  if (obj.type !== 'commit') throw new Error(`${oid} is a ${obj.type}, not a commit`);
  if (obj.commit !== undefined) return obj.commit;
  const { headers, message } = splitHeaders(obj.data);
  const info: CommitInfo = { tree: '', parents: [], author: '', committer: '', message };
  for (const [key, value] of headers) {
    if (key === 'tree') info.tree = value;
    else if (key === 'parent') info.parents.push(value);
    else if (key === 'author') info.author = value;
    else if (key === 'committer') info.committer = value;
  }
  obj.commit = info;
  return info;
}

export function tagInfo(oid: string): TagInfo {
  const obj = needObject(oid);
  if (obj.type !== 'tag') throw new Error(`${oid} is a ${obj.type}, not a tag`);
  if (obj.tagInfo !== undefined) return obj.tagInfo;
  const { headers, message } = splitHeaders(obj.data);
  const info: TagInfo = { object: '', type: '', tag: '', tagger: '', message };
  for (const [key, value] of headers) {
    if (key === 'object') info.object = value;
    else if (key === 'type') info.type = value;
    else if (key === 'tag') info.tag = value;
    else if (key === 'tagger') info.tagger = value;
  }
  obj.tagInfo = info;
  return info;
}

export interface NewCommit {
  tree: string;
  parents: string[];
  /** `Name <email>` */
  who: string;
  /** Seconds since the epoch. */
  when: number;
  message: string;
}

export function writeCommit(c: NewCommit): string {
  let text = `tree ${c.tree}\n`;
  for (const parent of c.parents) text += `parent ${parent}\n`;
  text += `author ${c.who} ${c.when} +0000\ncommitter ${c.who} ${c.when} +0000\n\n`;
  text += c.message.endsWith('\n') ? c.message : `${c.message}\n`;
  return putObject('commit', Buffer.from(text, 'utf8'));
}

/** Follow tag objects down to what they finally name; `null` when the chain is broken. */
export function peel(oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 16; hops += 1) {
    const obj = db.get(current);
    if (obj === undefined) return null;
    if (obj.type !== 'tag') return current;
    current = tagInfo(current).object;
  }
  return null;
}

/** The commit a ref value resolves to, or null when it does not name one. */
export function peelToCommit(oid: string): string | null {
  const target = peel(oid);
  if (target === null) return null;
  return db.get(target)?.type === 'commit' ? target : null;
}

/** `Name <mail> 1700000000 +0000` split into its parts. */
export function parseIdent(line: string): { name: string; email: string; seconds: number } {
  const match = /^(.*?) <([^>]*)> (\d+)/.exec(line);
  if (match === null) return { name: line, email: '', seconds: 0 };
  return { name: match[1] ?? '', email: match[2] ?? '', seconds: Number(match[3]) };
}
