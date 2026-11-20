// Walks over the commit graph: ancestry tests, merge bases, history listings, and the object
// selection a fetch answers with (including shallow boundaries).

import { commitInfo, getObject, isDirMode, tagInfo, treeEntries } from './objects.ts';

/** Whether `ancestor` is `descendant` itself or reachable from it through parents. */
export function isAncestor(ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>([descendant]);
  const queue = [descendant];
  for (let head = 0; head < queue.length; head += 1) {
    const obj = getObject(queue[head]!);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of commitInfo(queue[head]!).parents) {
      if (parent === ancestor) return true;
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return false;
}

/** Every commit reachable from `tip`, nearest first (breadth first over parents). */
export function history(tip: string, limit = Infinity): string[] {
  const seen = new Set<string>([tip]);
  const queue = [tip];
  for (let head = 0; head < queue.length && queue.length < limit; head += 1) {
    const obj = getObject(queue[head]!);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of commitInfo(queue[head]!).parents) {
      if (!seen.has(parent) && getObject(parent) !== undefined) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return queue.length > limit ? queue.slice(0, limit) : queue;
}

/** The nearest commit of `b`'s history that is also in `a`'s, or null for unrelated histories. */
export function mergeBase(a: string, b: string): string | null {
  const mine = new Set(history(a));
  for (const oid of history(b)) if (mine.has(oid)) return oid;
  return null;
}

/** Add a tree and everything under it to `into`, skipping what `skip` already holds. */
function addTree(oid: string, into: Set<string>, skip: Set<string> | null): void {
  if (into.has(oid) || (skip !== null && skip.has(oid))) return;
  if (getObject(oid) === undefined) return;
  into.add(oid);
  for (const entry of treeEntries(oid)) {
    if (isDirMode(entry.mode)) addTree(entry.oid, into, skip);
    else if (entry.mode !== '160000' && !into.has(entry.oid) && (skip === null || !skip.has(entry.oid)) && getObject(entry.oid) !== undefined) {
      into.add(entry.oid);
    }
  }
}

export interface FetchWant {
  wants: string[];
  haves: string[];
  /** Commits the client holds without their parents. */
  shallow: string[];
  /** 0 means no depth limit. */
  depth: number;
  /** `deepen-relative`: the depth counts from the client's current shallow boundary. */
  relative?: boolean;
}

/** How many generations below `tips` the deepest of `marks` sits (0 when none is reachable). */
function deepestLevel(tips: string[], marks: Set<string>): number {
  let deepest = 0;
  let frontier = tips.filter((oid) => getObject(oid)?.type === 'commit');
  const seen = new Set(frontier);
  for (let depth = 1; frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const oid of frontier) {
      if (marks.has(oid)) {
        deepest = Math.max(deepest, depth);
        continue;
      }
      for (const parent of commitInfo(oid).parents) {
        if (!seen.has(parent) && getObject(parent)?.type === 'commit') {
          seen.add(parent);
          next.push(parent);
        }
      }
    }
    frontier = next;
  }
  return deepest;
}

export interface FetchPlan {
  /** Objects to send, commits and tags first. */
  oids: string[];
  shallow: string[];
  unshallow: string[];
  /** The `have` ids the server also knows. */
  common: string[];
}

/** Decide what a fetch sends. Throws when a wanted id is unknown. */
export function planFetch(request: FetchWant): FetchPlan {
  const clientShallow = new Set(request.shallow);

  // What the client already has: the haves' commits (stopping where its history is cut off).
  const heldCommits = new Set<string>();
  const common: string[] = [];
  const stack: string[] = [];
  for (const have of request.haves) {
    const obj = getObject(have);
    if (obj === undefined) continue;
    common.push(have);
    let commit: string | null = have;
    if (obj.type === 'tag') {
      let target = tagInfo(have).object;
      while (getObject(target)?.type === 'tag') target = tagInfo(target).object;
      commit = getObject(target)?.type === 'commit' ? target : null;
    } else if (obj.type !== 'commit') commit = null;
    if (commit !== null && !heldCommits.has(commit)) {
      heldCommits.add(commit);
      stack.push(commit);
    }
  }
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (clientShallow.has(oid)) continue;
    for (const parent of commitInfo(oid).parents) {
      if (!heldCommits.has(parent) && getObject(parent)?.type === 'commit') {
        heldCommits.add(parent);
        stack.push(parent);
      }
    }
  }
  const held = new Set<string>();
  for (const oid of heldCommits) addTree(commitInfo(oid).tree, held, null);

  // The commits to offer, level by level so a depth limit can cut the walk.
  const head: string[] = [];
  const picked = new Set<string>();
  const level = new Map<string, number>();
  let frontier: string[] = [];
  const direct: string[] = [];
  for (const want of request.wants) {
    let oid = want;
    let obj = getObject(oid);
    if (obj === undefined) throw new Error(`not our ref ${want}`);
    while (obj !== undefined && obj.type === 'tag') {
      if (!picked.has(oid)) {
        picked.add(oid);
        head.push(oid);
      }
      oid = tagInfo(oid).object;
      obj = getObject(oid);
    }
    if (obj === undefined) continue;
    if (obj.type === 'commit') {
      if (!level.has(oid)) {
        level.set(oid, 1);
        frontier.push(oid);
      }
    } else if (!picked.has(oid)) {
      picked.add(oid);
      direct.push(oid);
    }
  }
  const limited = request.depth > 0;
  const maxDepth = request.relative === true && limited ? deepestLevel(frontier, clientShallow) + request.depth : request.depth;
  const boundary = new Set<string>();
  const commits: string[] = [];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const oid of frontier) {
      const depth = level.get(oid)!;
      const sendIt = !heldCommits.has(oid);
      if (sendIt) commits.push(oid);
      // Without a depth limit the walk stops at what the client holds; with one it runs to the
      // limit regardless, because deepening reaches behind commits the client already has.
      if (!limited && !sendIt) continue;
      const parents = commitInfo(oid).parents.filter((parent) => getObject(parent)?.type === 'commit');
      if (limited && depth >= maxDepth) {
        if (parents.length > 0) boundary.add(oid);
        continue;
      }
      for (const parent of parents) {
        if (!level.has(parent)) {
          level.set(parent, depth + 1);
          next.push(parent);
        }
      }
    }
    frontier = next;
  }

  const oids: string[] = head.concat(commits);
  const body = new Set<string>();
  for (const oid of commits) addTree(commitInfo(oid).tree, body, held);
  for (const oid of direct) {
    if (getObject(oid)?.type === 'tree') addTree(oid, body, held);
    else if (!held.has(oid)) body.add(oid);
  }
  for (const oid of body) oids.push(oid);

  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (limited) {
    for (const oid of boundary) if (!clientShallow.has(oid)) shallow.push(oid);
    for (const oid of clientShallow) if (level.has(oid) && !boundary.has(oid)) unshallow.push(oid);
  }
  return { oids, shallow, unshallow, common };
}
