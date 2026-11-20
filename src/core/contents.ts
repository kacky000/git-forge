// The contents API: read a file or a directory at a ref, and write or delete one file as a
// commit on a branch.

import { ApiError, invalid, notFound, type Json } from './errors.ts';
import { api, branchTip, commitJson, ident, resolveCommit, setRef } from './repos.ts';
import { clockSeconds, site, tick, viewer, type Repo } from './state.ts';
import { commitInfo, getObject, putObject, treeEntries, writeCommit, isDirMode } from '../git/objects.ts';
import { lookup, splitPath, withPath } from '../git/tree.ts';

function wrapBase64(data: Buffer): string {
  const flat = data.toString('base64');
  let out = '';
  for (let pos = 0; pos < flat.length; pos += 60) out += `${flat.slice(pos, pos + 60)}\n`;
  return out;
}

function entryJson(repo: Repo, path: string, name: string, oid: string, dir: boolean, ref: string, withContent: boolean): Json {
  const base = api(`/repos/${viewer.login}/${repo.name}`);
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  const self = `${base}/contents/${encoded}?ref=${encodeURIComponent(ref)}`;
  const kind = dir ? 'tree' : 'blob';
  const html = `${site.origin}/${viewer.login}/${repo.name}/${kind}/${ref}/${encoded}`;
  const git = `${base}/git/${kind}s/${oid}`;
  const out: Json = {
    name,
    path,
    sha: oid,
    size: dir ? 0 : getObject(oid)?.data.length ?? 0,
    url: self,
    html_url: html,
    git_url: git,
    download_url: dir ? null : `${site.origin}/${viewer.login}/${repo.name}/raw/${ref}/${encoded}`,
    type: dir ? 'dir' : 'file',
  };
  if (withContent && !dir) {
    out.content = wrapBase64(getObject(oid)?.data ?? Buffer.alloc(0));
    out.encoding = 'base64';
  }
  out._links = { self, git, html };
  return out;
}

export function getContents(repo: Repo, path: string, ref: string | undefined): Json | Json[] {
  const commit = resolveCommit(repo, ref);
  if (commit === null) {
    if (repo.refs.size === 0) throw new ApiError(404, 'This repository is empty.');
    throw new ApiError(404, ref === undefined ? 'Not Found' : `No commit found for the ref ${ref}`);
  }
  const parts = splitPath(path);
  const hit = lookup(commitInfo(commit).tree, parts);
  if (hit === null) throw notFound();
  const shownRef = ref === undefined || ref === '' ? repo.defaultBranch : ref;
  const clean = parts.join('/');
  if (!hit.dir) return entryJson(repo, clean, parts[parts.length - 1] ?? '', hit.oid, false, shownRef, true);
  return treeEntries(hit.oid).map((entry) =>
    entryJson(repo, clean === '' ? entry.name : `${clean}/${entry.name}`, entry.name, entry.oid, isDirMode(entry.mode), shownRef, false),
  );
}

interface WriteTarget {
  branch: string;
  tip: string | undefined;
  tree: string | null;
  parts: string[];
  existing: string | null;
}

function target(repo: Repo, path: string, input: Json): WriteTarget {
  const parts = splitPath(path);
  if (parts.length === 0 || parts.includes('..')) throw invalid('path cannot be empty or contain ..', 'Commit', 'path');
  const branch = typeof input.branch === 'string' && input.branch !== '' ? input.branch : repo.defaultBranch;
  const tip = branchTip(repo, branch);
  if (tip === undefined && repo.refs.size > 0 && typeof input.branch === 'string' && input.branch !== '') {
    throw new ApiError(404, `Branch ${branch} not found`);
  }
  const tree = tip === undefined ? null : commitInfo(tip).tree;
  const hit = tree === null ? null : lookup(tree, parts);
  if (hit !== null && hit.dir) throw invalid('path is a directory', 'Commit', 'path');
  return { branch, tip, tree, parts, existing: hit === null ? null : hit.oid };
}

function author(input: Json): string {
  const who = input.committer ?? input.author;
  if (typeof who === 'object' && who !== null) {
    const name = (who as Json).name;
    const email = (who as Json).email;
    if (typeof name === 'string' && typeof email === 'string' && name !== '' && email !== '') return `${name.replace(/[<>\n]/g, '')} <${email.replace(/[<>\n]/g, '')}>`;
  }
  return ident();
}

/** PUT contents: `created` tells the router whether to answer 201 or 200. */
export function putContents(repo: Repo, path: string, input: Json): { created: boolean; body: Json } {
  if (typeof input.message !== 'string' || input.message === '') throw invalid('Invalid request.\n\n"message" wasn\'t supplied.', 'Commit', 'message', 'missing_field');
  if (typeof input.content !== 'string') throw invalid('Invalid request.\n\n"content" wasn\'t supplied.', 'Commit', 'content', 'missing_field');
  const flat = input.content.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(flat)) throw invalid('content is not valid Base64', 'Commit', 'content');
  const where = target(repo, path, input);
  const given = typeof input.sha === 'string' ? input.sha.toLowerCase() : null;
  if (where.existing !== null) {
    if (given === null) throw invalid('Invalid request.\n\n"sha" wasn\'t supplied.', 'Commit', 'sha', 'missing_field');
    if (given !== where.existing) throw new ApiError(409, `${where.parts.join('/')} does not match ${given}`);
  } else if (given !== null) {
    // A sha for a file that is not there: the caller's view of the branch is stale.
    throw new ApiError(409, `${where.parts.join('/')} does not match ${given}`);
  }
  const blob = putObject('blob', Buffer.from(flat, 'base64'));
  const tree = withPath(where.tree, where.parts, blob);
  tick();
  const commit = writeCommit({ tree, parents: where.tip === undefined ? [] : [where.tip], who: author(input), when: clockSeconds(), message: input.message });
  setRef(repo, `refs/heads/${where.branch}`, commit);
  const clean = where.parts.join('/');
  return {
    created: where.existing === null,
    body: {
      content: entryJson(repo, clean, where.parts[where.parts.length - 1]!, blob, false, where.branch, true),
      commit: gitCommitJson(repo, commit),
    },
  };
}

export function deleteContents(repo: Repo, path: string, input: Json): Json {
  if (typeof input.message !== 'string' || input.message === '') throw invalid('Invalid request.\n\n"message" wasn\'t supplied.', 'Commit', 'message', 'missing_field');
  const where = target(repo, path, input);
  if (where.existing === null || where.tip === undefined) throw notFound();
  const given = typeof input.sha === 'string' ? input.sha.toLowerCase() : null;
  if (given === null) throw invalid('Invalid request.\n\n"sha" wasn\'t supplied.', 'Commit', 'sha', 'missing_field');
  if (given !== where.existing) throw new ApiError(409, `${where.parts.join('/')} does not match ${given}`);
  const tree = withPath(where.tree, where.parts, null);
  tick();
  const commit = writeCommit({ tree, parents: [where.tip], who: author(input), when: clockSeconds(), message: input.message });
  setRef(repo, `refs/heads/${where.branch}`, commit);
  return { content: null, commit: gitCommitJson(repo, commit) };
}

/** The Git Data shape of a commit (what a contents write answers under `commit`). */
export function gitCommitJson(repo: Repo, oid: string): Json {
  const full = commitJson(repo, oid);
  const inner = full.commit as Json;
  return {
    sha: oid,
    node_id: full.node_id,
    url: inner.url,
    html_url: full.html_url,
    author: inner.author,
    committer: inner.committer,
    tree: inner.tree,
    message: inner.message,
    parents: full.parents,
    verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
  };
}
