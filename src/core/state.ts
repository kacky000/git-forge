// The forge's whole state: one account (the bearer token's), its repositories, and what they
// hold. Everything lives in memory; a trial starts from an empty forge.

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface Comment {
  id: number;
  body: string;
  created: string;
  updated: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  stateReason: string | null;
  labels: string[];
  comments: Comment[];
  created: string;
  updated: string;
  closed: string | null;
  /** Bumped on every change, for `sort=updated`. */
  touched: number;
  /** Set when this number is a pull request. */
  pull: Pull | null;
  /** The serialized REST body, dropped whenever the issue changes. */
  cache: Buffer | null;
}

export interface Pull {
  head: string;
  base: string;
  /** The tips recorded when the pull request was opened or, once merged, at the merge. */
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeSha: string | null;
  draft: boolean;
}

export interface Repo {
  id: number;
  name: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
  created: string;
  updated: string;
  pushed: string;
  /** Full ref name (refs/heads/x, refs/tags/y) to object id. */
  refs: Map<string, string>;
  /** Bumped whenever a ref moves, so cached advertisements know when they are stale. */
  refsVersion: number;
  issues: Map<number, Issue>;
  lastNumber: number;
  labels: Map<string, Label>;
  adCache: Map<string, { version: number; body: Buffer }>;
}

/** The scenario's token owner. The first owner a request names replaces it (see `adoptOwner`). */
const FALLBACK_LOGIN = 'adaiversen';

export const viewer = {
  login: process.env.FORGE_LOGIN ?? FALLBACK_LOGIN,
  id: 1,
  pinned: process.env.FORGE_LOGIN !== undefined,
};

export const repos = new Map<string, Repo>();

/** Global ids to what they name, for GraphQL's `node(id:)` and the mutations' inputs. */
export const nodes = new Map<string, { kind: 'Repository' | 'Issue' | 'PullRequest' | 'IssueComment' | 'User' | 'Label'; repo?: Repo; issue?: Issue; comment?: Comment; label?: Label }>();

let sequence = 0;
export function nextId(): number {
  sequence += 1;
  return sequence;
}

/** An opaque global id, stable for the object's life. */
export function nodeId(kind: string, id: number): string {
  const tag = kind === 'Repository' ? 'R' : kind === 'Issue' ? 'I' : kind === 'PullRequest' ? 'PR' : kind === 'IssueComment' ? 'IC' : kind === 'User' ? 'U' : 'LA';
  return `${tag}_${Buffer.from(`${kind}:${id}`, 'utf8').toString('base64url')}`;
}

// The forge's clock is logical: it starts at the trial's stated opening time and moves one
// second per recorded event, so two runs of the same requests produce the same timestamps
// (and therefore the same commit ids).
const opening = Date.parse(process.env.MAKEFUN_TRIAL_NOW ?? '');
let clockMs = Number.isFinite(opening) ? opening : Date.UTC(2026, 0, 1);

export function tick(): string {
  clockMs += 1000;
  return new Date(clockMs).toISOString().replace('.000Z', 'Z');
}

export function clockSeconds(): number {
  return Math.floor(clockMs / 1000);
}

export function isoOf(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace('.000Z', 'Z');
}

/**
 * The token names exactly one account, but the token itself does not spell its login. The
 * first owner a repository-scoped request addresses is therefore taken as that login, once.
 */
export function adoptOwner(owner: string): void {
  if (viewer.pinned) return;
  viewer.pinned = true;
  if (owner !== '' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(owner)) viewer.login = owner;
}

/** The origin requests arrive on, for the absolute URLs in answers. */
export const site = { origin: 'http://localhost' };

export function findRepo(owner: string, name: string): Repo | undefined {
  if (owner.toLowerCase() !== viewer.login.toLowerCase()) return undefined;
  return repos.get(name.toLowerCase());
}
