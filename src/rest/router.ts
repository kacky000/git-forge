// REST v3: every route under /api/v3. The router maps a method and path to a service call and
// returns the reply as data; app.ts writes it to the socket.

import { ApiError, isObject, notFound, type Json } from '../core/errors.ts';
import { adoptOwner, site, viewer, type Repo } from '../core/state.ts';
import {
  api,
  branchJson,
  branchTip,
  commitJson,
  createRef,
  createRepo,
  deleteRepo,
  listBranches,
  listCommits,
  listRefs,
  listRepos,
  needRepo,
  refJson,
  repoJson,
  resolveCommit,
  setRef,
  updateRepo,
  userJson,
} from '../core/repos.ts';
import { deleteContents, getContents, gitCommitJson, putContents } from '../core/contents.ts';
import { addComment, commentJson, createLabel, editIssue, issueBytes, issueJson, labelJson, listIssues, needIssue, openIssue } from '../core/issues.ts';
import { editPull, mergePull, needPull, openPull, pullJson, pullFilesJson, pullTips } from '../core/pulls.ts';
import { commitInfo, getObject, isDirMode, peel, treeEntries } from '../git/objects.ts';
import { history, isAncestor } from '../git/graph.ts';

export interface Reply {
  status: number;
  /** The JSON body, already serialized; null for a reply without one (204). */
  body: Buffer | null;
  link?: string;
}

function json(status: number, value: unknown): Reply {
  return { status, body: Buffer.from(JSON.stringify(value), 'utf8') };
}

export function errorReply(err: unknown): Reply {
  if (err instanceof ApiError) {
    const body: Json = { message: err.message, documentation_url: 'https://docs.github.com/rest' };
    if (err.errors !== undefined) body.errors = err.errors;
    if (err.status >= 400 && err.status < 500) body.status = String(err.status);
    return json(err.status, body);
  }
  process.stderr.write(`[forge] internal error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  return json(500, { message: 'Server Error' });
}

/** Decode one path segment; a broken escape stays as it was written. */
function decode(part: string): string {
  if (part.indexOf('%') < 0) return part;
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

function parseBody(method: string, raw: Buffer): Json {
  if (method === 'GET' || method === 'HEAD' || raw.length === 0) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new ApiError(400, 'Problems parsing JSON');
  }
  if (!isObject(value)) throw new ApiError(400, 'Body should be a JSON object');
  return value;
}

interface Page {
  perPage: number;
  page: number;
}

function pageOf(query: URLSearchParams): Page {
  const perPage = Number(query.get('per_page') ?? '30');
  const page = Number(query.get('page') ?? '1');
  return {
    perPage: Number.isInteger(perPage) && perPage > 0 ? Math.min(perPage, 100) : 30,
    page: Number.isInteger(page) && page > 0 ? page : 1,
  };
}

/** One page of `items`, with the Link header that leads to its neighbours. */
function paged<T>(items: T[], query: URLSearchParams, path: string, render: (item: T) => unknown): Reply {
  const { perPage, page } = pageOf(query);
  const pages = Math.max(1, Math.ceil(items.length / perPage));
  const slice = items.slice((page - 1) * perPage, page * perPage);
  const reply = json(200, slice.map(render));
  if (pages > 1) {
    const urlFor = (n: number): string => {
      const next = new URLSearchParams(query);
      next.set('page', String(n));
      return `<${site.origin}/api/v3${path}?${next.toString()}>`;
    };
    const links: string[] = [];
    if (page > 1) links.push(`${urlFor(page - 1)}; rel="prev"`);
    if (page < pages) links.push(`${urlFor(page + 1)}; rel="next"`, `${urlFor(pages)}; rel="last"`);
    if (page > 1) links.push(`${urlFor(1)}; rel="first"`);
    reply.link = links.join(', ');
  }
  return reply;
}

const ROOT: Json = {
  current_user_url: '/api/v3/user',
  current_user_repositories_url: '/api/v3/user/repos{?type,page,per_page,sort}',
  repository_url: '/api/v3/repos/{owner}/{repo}',
  issues_url: '/api/v3/issues',
  rate_limit_url: '/api/v3/rate_limit',
  user_url: '/api/v3/users/{user}',
  user_repositories_url: '/api/v3/users/{user}/repos{?type,page,per_page,sort}',
};

const META: Json = {
  verifiable_password_authentication: false,
  installed_version: '3.14.0',
  api: [],
  git: [],
};

const LIMIT = { limit: 5000, used: 0, remaining: 5000, reset: 0 };

/** Handle one REST request. `path` is what follows /api/v3, starting with '/' (or empty). */
export function rest(method: string, path: string, search: string, raw: Buffer): Reply {
  try {
    const parts = path.split('/');
    // parts[0] is '' (the path starts with '/'); a trailing slash leaves a last ''.
    if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
    const head = parts[1];
    if (head === 'repos' && parts.length >= 4) {
      const owner = decode(parts[2]!);
      adoptOwner(owner);
      // The hot path: reading one issue needs neither the query string nor a body.
      if (method === 'GET' && parts.length === 6 && parts[4] === 'issues') {
        const repo = needRepo(owner, decode(parts[3]!));
        return { status: 200, body: issueBytes(repo, needIssue(repo, parts[5])) };
      }
      const repo = needRepo(owner, decode(parts[3]!));
      const body = parseBody(method, raw);
      return repoRoute(method, repo, parts.slice(4).map(decode), new URLSearchParams(search), body, path);
    }
    const body = parseBody(method, raw);
    const query = new URLSearchParams(search);
    if (head === undefined) {
      if (method === 'GET') return json(200, ROOT);
    } else if (head === 'meta' && parts.length === 2) {
      if (method === 'GET') return json(200, META);
    } else if (head === 'rate_limit' && parts.length === 2) {
      if (method === 'GET') return json(200, { resources: { core: LIMIT, graphql: LIMIT, search: LIMIT }, rate: LIMIT });
    } else if (head === 'user' && parts.length === 2) {
      if (method === 'GET') return json(200, { ...userJson(), name: viewer.login, email: null, public_repos: listRepos().length });
    } else if (head === 'user' && parts[2] === 'repos' && parts.length === 3) {
      if (method === 'GET') return paged(listRepos(), query, path, repoJson);
      if (method === 'POST') return json(201, repoJson(createRepo(body)));
    } else if (head === 'users' && parts.length >= 3) {
      if (decode(parts[2]!).toLowerCase() !== viewer.login.toLowerCase()) throw notFound();
      if (method === 'GET' && parts.length === 3) return json(200, { ...userJson(), name: viewer.login });
      if (method === 'GET' && parts[3] === 'repos' && parts.length === 4) return paged(listRepos(), query, path, repoJson);
    } else if (head === 'repositories' && parts.length === 2) {
      if (method === 'GET') return paged(listRepos().filter((repo) => !repo.private), query, path, repoJson);
    }
    throw notFound();
  } catch (err) {
    return errorReply(err);
  }
}

function repoRoute(method: string, repo: Repo, tail: string[], query: URLSearchParams, body: Json, path: string): Reply {
  const [area, second, third] = tail;
  if (area === undefined) {
    if (method === 'GET') return json(200, repoJson(repo));
    if (method === 'PATCH') {
      updateRepo(repo, body);
      return json(200, repoJson(repo));
    }
    if (method === 'DELETE') {
      deleteRepo(repo);
      return { status: 204, body: null };
    }
    throw notFound();
  }
  switch (area) {
    case 'issues':
      return issueRoute(method, repo, tail, query, body, path);
    case 'pulls':
      return pullRoute(method, repo, tail, query, body, path);
    case 'contents': {
      const file = tail.slice(1).join('/');
      if (method === 'GET') return json(200, getContents(repo, file, query.get('ref') ?? undefined));
      if (method === 'PUT') {
        const done = putContents(repo, file, body);
        return json(done.created ? 201 : 200, done.body);
      }
      if (method === 'DELETE') {
        // A DELETE may carry its fields in the query string instead of a body.
        const input: Json = { ...body };
        for (const key of ['message', 'sha', 'branch']) if (input[key] === undefined && query.has(key)) input[key] = query.get(key);
        return json(200, deleteContents(repo, file, input));
      }
      break;
    }
    case 'readme':
      if (method === 'GET') {
        for (const name of ['README.md', 'README', 'readme.md', 'README.txt']) {
          try {
            return json(200, getContents(repo, name, query.get('ref') ?? undefined));
          } catch {
            // try the next spelling
          }
        }
      }
      break;
    case 'branches': {
      if (method !== 'GET') break;
      if (second === undefined) return paged(listBranches(repo), query, path, (item) => item);
      const name = tail.slice(1).join('/');
      const tip = branchTip(repo, name);
      if (tip === undefined) throw new ApiError(404, 'Branch not found');
      return json(200, branchJson(repo, name, tip, true));
    }
    case 'commits': {
      if (method !== 'GET') break;
      if (second === undefined) return paged(listCommits(repo, query.get('sha') ?? undefined), query, path, (oid) => commitJson(repo, oid));
      const oid = resolveCommit(repo, tail.slice(1).join('/'));
      if (oid === null) throw new ApiError(422, `No commit found for SHA: ${tail.slice(1).join('/')}`);
      return json(200, commitJson(repo, oid));
    }
    case 'tags':
      if (method === 'GET' && second === undefined) {
        const tags = [...repo.refs].filter(([ref]) => ref.startsWith('refs/tags/')).sort(([a], [b]) => (a < b ? -1 : 1));
        return paged(tags, query, path, ([ref, oid]) => {
          const sha = peel(oid) ?? oid;
          return { name: ref.slice(10), commit: { sha, url: api(`/repos/${viewer.login}/${repo.name}/commits/${sha}`) }, node_id: `T_${oid}` };
        });
      }
      break;
    case 'labels':
      if (second === undefined) {
        if (method === 'GET') return paged([...repo.labels.values()], query, path, (label) => labelJson(repo, label));
        if (method === 'POST') return json(201, labelJson(repo, createLabel(repo, body)));
      } else if (method === 'GET' && third === undefined) {
        const label = repo.labels.get(second.toLowerCase());
        if (label === undefined) throw notFound();
        return json(200, labelJson(repo, label));
      }
      break;
    case 'git':
      return gitDataRoute(method, repo, tail, body);
    case 'compare':
      if (method === 'GET' && second !== undefined) {
        const [from, to] = tail.slice(1).join('/').split('...');
        const base = resolveCommit(repo, from);
        const tip = resolveCommit(repo, to);
        if (base === null || tip === null) throw notFound();
        const ahead = history(tip).filter((oid) => !isAncestor(oid, base));
        const behind = history(base).filter((oid) => !isAncestor(oid, tip));
        return json(200, {
          status: ahead.length === 0 ? (behind.length === 0 ? 'identical' : 'behind') : behind.length === 0 ? 'ahead' : 'diverged',
          ahead_by: ahead.length,
          behind_by: behind.length,
          total_commits: ahead.length,
          base_commit: commitJson(repo, base),
          commits: ahead.reverse().map((oid) => commitJson(repo, oid)),
        });
      }
      break;
    default:
      break;
  }
  throw notFound();
}

function issueRoute(method: string, repo: Repo, tail: string[], query: URLSearchParams, body: Json, path: string): Reply {
  const [, number, sub, extra] = tail;
  if (number === undefined) {
    if (method === 'GET') {
      const found = listIssues(repo, {
        state: query.get('state') ?? undefined,
        sort: query.get('sort') ?? undefined,
        direction: query.get('direction') ?? undefined,
        labels: query.get('labels') ?? undefined,
      });
      return paged(found, query, path, (issue) => issueJson(repo, issue));
    }
    if (method === 'POST') return json(201, issueJson(repo, openIssue(repo, body, null)));
    throw notFound();
  }
  const issue = needIssue(repo, number);
  if (sub === undefined) {
    if (method === 'GET') return { status: 200, body: issueBytes(repo, issue) };
    if (method === 'PATCH') {
      editIssue(repo, issue, body);
      return { status: 200, body: issueBytes(repo, issue) };
    }
  } else if (sub === 'comments' && extra === undefined) {
    if (method === 'GET') return paged(issue.comments, query, path, (comment) => commentJson(repo, issue, comment));
    if (method === 'POST') return json(201, commentJson(repo, issue, addComment(repo, issue, body)));
  } else if (sub === 'labels' && extra === undefined) {
    if (method === 'GET') return json(200, issue.labels.map((name) => labelJson(repo, repo.labels.get(name.toLowerCase())!)));
    if (method === 'POST' || method === 'PUT') {
      const names = Array.isArray(body.labels) ? body.labels : [];
      editIssue(repo, issue, { labels: method === 'PUT' ? names : [...issue.labels, ...names] });
      return json(200, issue.labels.map((name) => labelJson(repo, repo.labels.get(name.toLowerCase())!)));
    }
  }
  throw notFound();
}

function pullRoute(method: string, repo: Repo, tail: string[], query: URLSearchParams, body: Json, path: string): Reply {
  const [, number, sub, extra] = tail;
  if (number === undefined) {
    if (method === 'GET') {
      const found = listIssues(repo, {
        state: query.get('state') ?? undefined,
        sort: query.get('sort') ?? undefined,
        direction: query.get('direction') ?? undefined,
        head: query.get('head') ?? undefined,
        base: query.get('base') ?? undefined,
        pulls: true,
      });
      return paged(found, query, path, (issue) => pullJson(repo, issue, false));
    }
    if (method === 'POST') return json(201, pullJson(repo, openPull(repo, body), true));
    throw notFound();
  }
  const issue = needPull(repo, number);
  if (sub === undefined) {
    if (method === 'GET') return json(200, pullJson(repo, issue, true));
    if (method === 'PATCH') {
      editPull(repo, issue, body);
      return json(200, pullJson(repo, issue, true));
    }
  } else if (extra === undefined) {
    if (sub === 'files' && method === 'GET') return paged(pullFilesJson(repo, issue), query, path, (file) => file);
    if (sub === 'commits' && method === 'GET') {
      const tips = pullTips(repo, issue);
      const own = history(tips.head).filter((oid) => !isAncestor(oid, tips.base)).reverse();
      return paged(own, query, path, (oid) => commitJson(repo, oid));
    }
    if (sub === 'merge') {
      if (method === 'PUT') return json(200, mergePull(repo, issue, body));
      if (method === 'GET') {
        if (issue.pull!.merged) return { status: 204, body: null };
        throw notFound();
      }
    }
  }
  throw notFound();
}

function gitDataRoute(method: string, repo: Repo, tail: string[], body: Json): Reply {
  const kind = tail[1];
  const rest = tail.slice(2).join('/');
  if (kind === 'refs' || kind === 'ref' || kind === 'matching-refs') {
    if (kind === 'refs' && rest === '' && method === 'POST') return json(201, createRef(repo, body));
    const ref = rest === '' ? 'refs' : `refs/${rest}`;
    const oid = repo.refs.get(ref);
    if (method === 'GET') {
      if (oid !== undefined && kind !== 'matching-refs') return json(200, refJson(repo, ref, oid));
      const many = listRefs(repo, ref);
      if (kind === 'ref' || (many.length === 0 && kind === 'refs' && rest !== '')) throw notFound();
      return json(200, many);
    }
    if (oid === undefined) throw new ApiError(422, 'Reference does not exist');
    if (method === 'PATCH') {
      const sha = typeof body.sha === 'string' ? body.sha.toLowerCase() : '';
      if (getObject(sha) === undefined) throw new ApiError(422, 'Object does not exist');
      if (body.force !== true && !isAncestor(oid, sha)) throw new ApiError(422, 'Update is not a fast forward');
      setRef(repo, ref, sha);
      return json(200, refJson(repo, ref, sha));
    }
    if (method === 'DELETE') {
      setRef(repo, ref, null);
      return { status: 204, body: null };
    }
    throw notFound();
  }
  if (method !== 'GET' || rest === '') throw notFound();
  const oid = rest.toLowerCase();
  const obj = getObject(oid);
  if (obj === undefined) throw notFound();
  const root = api(`/repos/${viewer.login}/${repo.name}/git`);
  if (kind === 'commits' && obj.type === 'commit') return json(200, gitCommitJson(repo, oid));
  if (kind === 'blobs' && obj.type === 'blob') {
    return json(200, { sha: oid, node_id: `B_${oid}`, size: obj.data.length, url: `${root}/blobs/${oid}`, content: obj.data.toString('base64'), encoding: 'base64' });
  }
  if (kind === 'trees') {
    const tree = obj.type === 'commit' ? commitInfo(oid).tree : obj.type === 'tree' ? oid : null;
    if (tree === null) throw notFound();
    return json(200, {
      sha: tree,
      url: `${root}/trees/${tree}`,
      tree: treeEntries(tree).map((entry) => {
        const dir = isDirMode(entry.mode);
        const item: Json = { path: entry.name, mode: dir ? '040000' : entry.mode, type: dir ? 'tree' : 'blob', sha: entry.oid, url: `${root}/${dir ? 'trees' : 'blobs'}/${entry.oid}` };
        if (!dir) item.size = getObject(entry.oid)?.data.length ?? 0;
        return item;
      }),
      truncated: false,
    });
  }
  throw notFound();
}
