// Repositories, their refs and their commit listings, in the shapes REST v3 answers with.

import { ApiError, invalid, notFound, type Json } from './errors.ts';
import { clockSeconds, findRepo, nextId, nodeId, nodes, repos, site, tick, viewer, type Repo } from './state.ts';
import { commitInfo, getObject, parseIdent, peelToCommit, writeCommit, writeTree } from '../git/objects.ts';
import { putObject } from '../git/objects.ts';
import { history } from '../git/graph.ts';
import { isoOf } from './state.ts';

const NAME_OK = /^[A-Za-z0-9._-]{1,100}$/;

export function api(path: string): string {
  return `${site.origin}/api/v3${path}`;
}

export function userJson(): Json {
  const login = viewer.login;
  return {
    login,
    id: viewer.id,
    node_id: nodeId('User', viewer.id),
    avatar_url: `${site.origin}/avatars/${login}`,
    gravatar_id: '',
    url: api(`/users/${login}`),
    html_url: `${site.origin}/${login}`,
    repos_url: api(`/users/${login}/repos`),
    type: 'User',
    site_admin: false,
  };
}

export function ident(): string {
  return `${viewer.login} <${viewer.login}@users.noreply.forge.invalid>`;
}

export function repoJson(repo: Repo): Json {
  const full = `${viewer.login}/${repo.name}`;
  const base = api(`/repos/${full}`);
  let open = 0;
  for (const issue of repo.issues.values()) if (issue.state === 'open') open += 1;
  return {
    id: repo.id,
    node_id: nodeId('Repository', repo.id),
    name: repo.name,
    full_name: full,
    private: repo.private,
    owner: userJson(),
    html_url: `${site.origin}/${full}`,
    description: repo.description,
    fork: false,
    url: base,
    created_at: repo.created,
    updated_at: repo.updated,
    pushed_at: repo.pushed,
    git_url: `${site.origin}/${full}.git`,
    clone_url: `${site.origin}/${full}.git`,
    ssh_url: `${site.origin}/${full}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    has_pages: false,
    has_downloads: true,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: open,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    forks: 0,
    open_issues: open,
    watchers: 0,
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    allow_squash_merge: true,
    allow_merge_commit: true,
    allow_rebase_merge: true,
    delete_branch_on_merge: false,
  };
}

export function createRepo(input: Json): Repo {
  const name = input.name;
  if (typeof name !== 'string' || name === '') throw invalid('Repository creation failed.', 'Repository', 'name', 'missing_field');
  if (!NAME_OK.test(name) || name.endsWith('.git')) throw invalid('Repository creation failed.', 'Repository', 'name', 'custom');
  const key = name.toLowerCase();
  if (repos.has(key)) {
    throw new ApiError(422, 'Repository creation failed.', [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }]);
  }
  const now = tick();
  const repo: Repo = {
    id: nextId(),
    name,
    description: typeof input.description === 'string' ? input.description : null,
    private: input.private === true || input.visibility === 'private',
    defaultBranch: typeof input.default_branch === 'string' && input.default_branch !== '' ? input.default_branch : 'main',
    created: now,
    updated: now,
    pushed: now,
    refs: new Map(),
    refsVersion: 0,
    issues: new Map(),
    lastNumber: 0,
    labels: new Map(),
    adCache: new Map(),
  };
  repos.set(key, repo);
  nodes.set(nodeId('Repository', repo.id), { kind: 'Repository', repo });
  if (input.auto_init === true) {
    const blob = putObject('blob', Buffer.from(`# ${name}\n${repo.description === null ? '' : `\n${repo.description}\n`}`, 'utf8'));
    const tree = writeTree([{ mode: '100644', name: 'README.md', oid: blob }]);
    const commit = writeCommit({ tree, parents: [], who: ident(), when: clockSeconds(), message: 'Initial commit' });
    setRef(repo, `refs/heads/${repo.defaultBranch}`, commit);
  }
  return repo;
}

export function needRepo(owner: string, name: string): Repo {
  const repo = findRepo(owner, name);
  if (repo === undefined) throw notFound();
  return repo;
}

export function updateRepo(repo: Repo, input: Json): void {
  if (typeof input.name === 'string' && input.name !== repo.name) {
    if (!NAME_OK.test(input.name)) throw invalid('Validation Failed', 'Repository', 'name', 'custom');
    if (repos.has(input.name.toLowerCase())) throw invalid('Validation Failed', 'Repository', 'name', 'custom');
    repos.delete(repo.name.toLowerCase());
    repo.name = input.name;
    repos.set(repo.name.toLowerCase(), repo);
  }
  if (typeof input.description === 'string' || input.description === null) repo.description = input.description as string | null;
  if (typeof input.private === 'boolean') repo.private = input.private;
  if (input.visibility === 'private' || input.visibility === 'public') repo.private = input.visibility === 'private';
  if (typeof input.default_branch === 'string') {
    if (!repo.refs.has(`refs/heads/${input.default_branch}`)) throw invalid('Validation Failed', 'Repository', 'default_branch', 'invalid');
    repo.defaultBranch = input.default_branch;
    repo.refsVersion += 1;
  }
  repo.updated = tick();
}

export function deleteRepo(repo: Repo): void {
  repos.delete(repo.name.toLowerCase());
  nodes.delete(nodeId('Repository', repo.id));
  for (const issue of repo.issues.values()) nodes.delete(nodeId(issue.pull === null ? 'Issue' : 'PullRequest', issue.id));
}

export function listRepos(): Repo[] {
  return [...repos.values()].sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1));
}

// ---------------------------------------------------------------- refs

export function setRef(repo: Repo, ref: string, oid: string | null): void {
  if (oid === null) repo.refs.delete(ref);
  else repo.refs.set(ref, oid);
  repo.refsVersion += 1;
  repo.pushed = tick();
}

export function branchTip(repo: Repo, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}

/** The branch HEAD names: the default branch when it exists, else nothing for an empty repo. */
export function headRef(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** Resolve what a `ref`/`sha` parameter names (branch, tag, full ref or commit id) to a commit. */
export function resolveCommit(repo: Repo, ref: string | undefined): string | null {
  const wanted = ref === undefined || ref === '' ? repo.defaultBranch : ref;
  const direct = repo.refs.get(`refs/heads/${wanted}`) ?? repo.refs.get(`refs/tags/${wanted}`) ?? repo.refs.get(wanted) ?? repo.refs.get(`refs/${wanted}`);
  if (direct !== undefined) return peelToCommit(direct);
  if (/^[0-9a-f]{40}$/i.test(wanted)) {
    const oid = wanted.toLowerCase();
    return getObject(oid) === undefined ? null : peelToCommit(oid);
  }
  return null;
}

export function refJson(repo: Repo, ref: string, oid: string): Json {
  const type = getObject(oid)?.type ?? 'commit';
  const root = api(`/repos/${viewer.login}/${repo.name}/git`);
  return {
    ref,
    node_id: `REF_${Buffer.from(`${repo.id}:${ref}`, 'utf8').toString('base64url')}`,
    url: `${root}/${ref}`,
    object: { sha: oid, type, url: `${root}/${type}s/${oid}` },
  };
}

export function createRef(repo: Repo, input: Json): Json {
  const ref = input.ref;
  const sha = input.sha;
  if (typeof ref !== 'string' || !ref.startsWith('refs/') || ref.split('/').length < 3) throw invalid('Reference name must start with refs/ and name a branch or tag', 'Reference', 'ref');
  if (typeof sha !== 'string' || getObject(sha.toLowerCase()) === undefined) throw invalid('Object does not exist', 'Reference', 'sha');
  if (repo.refs.has(ref)) throw invalid('Reference already exists', 'Reference', 'ref', 'already_exists');
  setRef(repo, ref, sha.toLowerCase());
  return refJson(repo, ref, sha.toLowerCase());
}

export function listRefs(repo: Repo, prefix: string): Json[] {
  const out: Json[] = [];
  for (const [ref, oid] of [...repo.refs].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (ref === prefix || ref.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`) || prefix === 'refs') out.push(refJson(repo, ref, oid));
  }
  return out;
}

export function branchJson(repo: Repo, name: string, oid: string, full: boolean): Json {
  const url = api(`/repos/${viewer.login}/${repo.name}/commits/${oid}`);
  return {
    name,
    commit: full ? commitJson(repo, oid) : { sha: oid, url },
    protected: false,
  };
}

export function listBranches(repo: Repo): Json[] {
  const out: Json[] = [];
  for (const [ref, oid] of [...repo.refs].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (ref.startsWith('refs/heads/')) out.push(branchJson(repo, ref.slice(11), oid, false));
  }
  return out;
}

// ---------------------------------------------------------------- commits

/** A commit's message the way the API shows it: without the newline git ends it with. */
export function shownMessage(message: string): string {
  return message.endsWith('\n') ? message.slice(0, -1) : message;
}

export function commitJson(repo: Repo, oid: string): Json {
  const info = commitInfo(oid);
  const author = parseIdent(info.author);
  const committer = parseIdent(info.committer);
  const base = api(`/repos/${viewer.login}/${repo.name}`);
  return {
    sha: oid,
    node_id: `C_${oid}`,
    commit: {
      author: { name: author.name, email: author.email, date: isoOf(author.seconds) },
      committer: { name: committer.name, email: committer.email, date: isoOf(committer.seconds) },
      message: shownMessage(info.message),
      tree: { sha: info.tree, url: `${base}/git/trees/${info.tree}` },
      url: `${base}/git/commits/${oid}`,
      comment_count: 0,
    },
    url: `${base}/commits/${oid}`,
    html_url: `${site.origin}/${viewer.login}/${repo.name}/commit/${oid}`,
    author: null,
    committer: null,
    parents: info.parents.map((sha) => ({ sha, url: `${base}/commits/${sha}` })),
  };
}

export function listCommits(repo: Repo, ref: string | undefined): string[] {
  if (repo.refs.size === 0) throw new ApiError(409, 'Git Repository is empty.');
  const tip = resolveCommit(repo, ref);
  if (tip === null) throw notFound();
  return history(tip);
}
