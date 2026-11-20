// Working with trees as if they were a file system: look a path up, write or remove a file,
// list what changed between two trees, and merge two trees over their common ancestor.

import { EMPTY_TREE, getObject, isDirMode, putObject, treeEntries, writeTree, type TreeEntry } from './objects.ts';

export interface PathHit {
  mode: string;
  oid: string;
  dir: boolean;
}

export function splitPath(path: string): string[] {
  return path.split('/').filter((part) => part !== '' && part !== '.');
}

/** What sits at `parts` under `tree`; the tree itself for an empty path. */
export function lookup(tree: string, parts: readonly string[]): PathHit | null {
  let current: PathHit = { mode: '40000', oid: tree, dir: true };
  for (const part of parts) {
    if (!current.dir) return null;
    const found = treeEntries(current.oid).find((entry) => entry.name === part);
    if (found === undefined) return null;
    current = { mode: found.mode, oid: found.oid, dir: isDirMode(found.mode) };
  }
  return current;
}

/**
 * A copy of `tree` (or of nothing) with `parts` set to `blob`, or removed when `blob` is null.
 * Directories that become empty disappear; an emptied root is the empty tree.
 */
export function withPath(tree: string | null, parts: readonly string[], blob: string | null, mode = '100644'): string {
  const out = rewrite(tree, parts, 0, blob, mode);
  return out ?? putObject('tree', Buffer.alloc(0));
}

function rewrite(tree: string | null, parts: readonly string[], at: number, blob: string | null, mode: string): string | null {
  const entries: TreeEntry[] = tree === null ? [] : treeEntries(tree).slice();
  const name = parts[at]!;
  const index = entries.findIndex((entry) => entry.name === name);
  if (at === parts.length - 1) {
    if (blob === null) {
      if (index >= 0) entries.splice(index, 1);
    } else if (index >= 0) entries[index] = { mode, name, oid: blob };
    else entries.push({ mode, name, oid: blob });
  } else {
    const existing = index >= 0 ? entries[index]! : undefined;
    const below = existing !== undefined && isDirMode(existing.mode) ? existing.oid : null;
    if (below === null && blob === null) return tree;
    const child = rewrite(below, parts, at + 1, blob, mode);
    if (child === null) {
      if (index >= 0) entries.splice(index, 1);
    } else if (index >= 0) entries[index] = { mode: '40000', name, oid: child };
    else entries.push({ mode: '40000', name, oid: child });
  }
  return entries.length === 0 ? null : writeTree(entries);
}

export interface FlatFile {
  mode: string;
  oid: string;
}

/** Every file under `tree`, keyed by its full path. */
export function flatten(tree: string | null, prefix = '', into = new Map<string, FlatFile>()): Map<string, FlatFile> {
  if (tree === null || tree === EMPTY_TREE || getObject(tree) === undefined) return into;
  for (const entry of treeEntries(tree)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (isDirMode(entry.mode)) flatten(entry.oid, path, into);
    else into.set(path, { mode: entry.mode, oid: entry.oid });
  }
  return into;
}

export interface FileChange {
  path: string;
  status: 'added' | 'removed' | 'modified';
  before: string | null;
  after: string | null;
}

/** The files that differ between two trees, by path, in path order. */
export function diffTrees(from: string | null, to: string | null): FileChange[] {
  const changes: FileChange[] = [];
  walkDiff(from, to, '', changes);
  changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return changes;
}

function walkDiff(from: string | null, to: string | null, prefix: string, out: FileChange[]): void {
  if (from === to) return;
  const left = from === null ? [] : treeEntries(from);
  const right = to === null ? [] : treeEntries(to);
  const names = new Map<string, { a?: TreeEntry; b?: TreeEntry }>();
  for (const entry of left) names.set(entry.name, { a: entry });
  for (const entry of right) {
    const slot = names.get(entry.name);
    if (slot === undefined) names.set(entry.name, { b: entry });
    else slot.b = entry;
  }
  for (const [name, { a, b }] of names) {
    const path = prefix === '' ? name : `${prefix}/${name}`;
    if (a !== undefined && b !== undefined && a.oid === b.oid && a.mode === b.mode) continue;
    const aDir = a !== undefined && isDirMode(a.mode);
    const bDir = b !== undefined && isDirMode(b.mode);
    if (aDir || bDir) {
      walkDiff(aDir ? a!.oid : null, bDir ? b!.oid : null, path, out);
      if (a !== undefined && !aDir) out.push({ path, status: 'removed', before: a.oid, after: null });
      if (b !== undefined && !bDir) out.push({ path, status: 'added', before: null, after: b.oid });
      continue;
    }
    if (a === undefined) out.push({ path, status: 'added', before: null, after: b!.oid });
    else if (b === undefined) out.push({ path, status: 'removed', before: a.oid, after: null });
    else out.push({ path, status: 'modified', before: a.oid, after: b.oid });
  }
}

/**
 * Three-way merge of whole files: a path changed on one side only takes that side, a path
 * changed identically on both takes either, and a path changed differently on both is a
 * conflict. Returns the merged tree, or null on a conflict.
 */
export function mergeTrees(base: string | null, ours: string, theirs: string): string | null {
  if (ours === theirs || base === theirs) return ours;
  if (base === ours) return theirs;
  const baseEntries = base === null ? [] : treeEntries(base);
  const ourEntries = treeEntries(ours);
  const theirEntries = treeEntries(theirs);
  const names = new Set<string>();
  for (const entry of baseEntries) names.add(entry.name);
  for (const entry of ourEntries) names.add(entry.name);
  for (const entry of theirEntries) names.add(entry.name);
  const merged: TreeEntry[] = [];
  const same = (x: TreeEntry | undefined, y: TreeEntry | undefined): boolean =>
    x === undefined ? y === undefined : y !== undefined && x.oid === y.oid && x.mode === y.mode;
  for (const name of names) {
    const b = baseEntries.find((entry) => entry.name === name);
    const o = ourEntries.find((entry) => entry.name === name);
    const t = theirEntries.find((entry) => entry.name === name);
    let pick: TreeEntry | undefined;
    if (same(o, t) || same(b, t)) pick = o;
    else if (same(b, o)) pick = t;
    else if (o !== undefined && t !== undefined && isDirMode(o.mode) && isDirMode(t.mode)) {
      const below = mergeTrees(b !== undefined && isDirMode(b.mode) ? b.oid : null, o.oid, t.oid);
      if (below === null) return null;
      pick = { mode: '40000', name, oid: below };
    } else return null;
    if (pick !== undefined) merged.push(pick);
  }
  return writeTree(merged);
}

function lineCount(data: Buffer): number {
  if (data.length === 0) return 0;
  let lines = 0;
  for (let i = 0; i < data.length; i += 1) if (data[i] === 10) lines += 1;
  return data[data.length - 1] === 10 ? lines : lines + 1;
}

/** Added and deleted line counts between two blobs (either may be absent). */
export function lineStat(before: string | null, after: string | null): { additions: number; deletions: number } {
  const a = before === null ? null : getObject(before)?.data ?? null;
  const b = after === null ? null : getObject(after)?.data ?? null;
  if (a === null) return { additions: b === null ? 0 : lineCount(b), deletions: 0 };
  if (b === null) return { additions: 0, deletions: lineCount(a) };
  const left = a.toString('utf8').split('\n');
  const right = b.toString('utf8').split('\n');
  if (left[left.length - 1] === '') left.pop();
  if (right[right.length - 1] === '') right.pop();
  // Trim what both ends share, then count the common lines of the middle (LCS) when it is
  // small enough; a huge middle is counted as fully replaced.
  let start = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start += 1;
  let endL = left.length;
  let endR = right.length;
  while (endL > start && endR > start && left[endL - 1] === right[endR - 1]) {
    endL -= 1;
    endR -= 1;
  }
  const n = endL - start;
  const m = endR - start;
  let shared = 0;
  if (n > 0 && m > 0 && n * m <= 4_000_000) {
    let prev = new Uint32Array(m + 1);
    let row = new Uint32Array(m + 1);
    for (let i = 1; i <= n; i += 1) {
      const line = left[start + i - 1];
      for (let j = 1; j <= m; j += 1) {
        row[j] = line === right[start + j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, row[j - 1]!);
      }
      const swap = prev;
      prev = row;
      row = swap;
    }
    shared = prev[m]!;
  }
  return { additions: m - shared, deletions: n - shared };
}
