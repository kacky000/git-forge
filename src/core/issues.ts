// Issues, their labels and comments. A pull request is an issue with a `pull` attached, so
// both share one number sequence per repository, as on GitHub.

import { ApiError, invalid, notFound, type Json } from './errors.ts';
import { api, userJson } from './repos.ts';
import { nextId, nodeId, nodes, site, tick, viewer, type Comment, type Issue, type Label, type Pull, type Repo } from './state.ts';

let touches = 0;

export function touch(issue: Issue): void {
  touches += 1;
  issue.touched = touches;
  issue.updated = tick();
  issue.cache = null;
}

// ---------------------------------------------------------------- labels

export function labelJson(repo: Repo, label: Label): Json {
  return {
    id: label.id,
    node_id: nodeId('Label', label.id),
    url: api(`/repos/${viewer.login}/${repo.name}/labels/${encodeURIComponent(label.name)}`),
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

export function createLabel(repo: Repo, input: Json): Label {
  const name = input.name;
  if (typeof name !== 'string' || name.trim() === '') throw invalid('Validation Failed', 'Label', 'name', 'missing_field');
  const key = name.toLowerCase();
  if (repo.labels.has(key)) throw invalid('Validation Failed', 'Label', 'name', 'already_exists');
  const label: Label = {
    id: nextId(),
    name,
    color: typeof input.color === 'string' ? input.color.replace(/^#/, '') : 'ededed',
    description: typeof input.description === 'string' ? input.description : null,
  };
  repo.labels.set(key, label);
  nodes.set(nodeId('Label', label.id), { kind: 'Label', repo, label });
  return label;
}

/** Label names as an issue carries them; a name the repository has no label for is a 422. */
function checkedLabels(repo: Repo, value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw invalid('Validation Failed', 'Issue', 'labels');
  const out: string[] = [];
  for (const item of value) {
    const name = typeof item === 'string' ? item : typeof item === 'object' && item !== null ? (item as Json).name : undefined;
    if (typeof name !== 'string') throw invalid('Validation Failed', 'Issue', 'labels');
    const label = repo.labels.get(name.toLowerCase());
    if (label === undefined) {
      throw new ApiError(422, 'Validation Failed', [{ value: name, resource: 'Label', field: 'name', code: 'invalid' }]);
    }
    if (!out.includes(label.name)) out.push(label.name);
  }
  return out;
}

// ---------------------------------------------------------------- issues

export function issueJson(repo: Repo, issue: Issue): Json {
  const root = api(`/repos/${viewer.login}/${repo.name}`);
  const kind = issue.pull === null ? 'issues' : 'pull';
  const out: Json = {
    url: `${root}/issues/${issue.number}`,
    repository_url: root,
    labels_url: `${root}/issues/${issue.number}/labels{/name}`,
    comments_url: `${root}/issues/${issue.number}/comments`,
    events_url: `${root}/issues/${issue.number}/events`,
    html_url: `${site.origin}/${viewer.login}/${repo.name}/${kind}/${issue.number}`,
    id: issue.id,
    node_id: nodeId(issue.pull === null ? 'Issue' : 'PullRequest', issue.id),
    number: issue.number,
    title: issue.title,
    user: userJson(),
    labels: issue.labels.map((name) => labelJson(repo, repo.labels.get(name.toLowerCase())!)),
    state: issue.state,
    locked: false,
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: issue.created,
    updated_at: issue.updated,
    closed_at: issue.closed,
    author_association: 'OWNER',
    body: issue.body,
    reactions: { url: `${root}/issues/${issue.number}/reactions`, total_count: 0 },
    timeline_url: `${root}/issues/${issue.number}/timeline`,
    state_reason: issue.stateReason,
  };
  if (issue.pull !== null) {
    out.pull_request = {
      url: `${root}/pulls/${issue.number}`,
      html_url: `${site.origin}/${viewer.login}/${repo.name}/pull/${issue.number}`,
      merged_at: issue.pull.mergedAt,
    };
  }
  return out;
}

/** The issue's REST body as bytes, built once and reused until the issue changes. */
export function issueBytes(repo: Repo, issue: Issue): Buffer {
  if (issue.cache === null) issue.cache = Buffer.from(JSON.stringify(issueJson(repo, issue)), 'utf8');
  return issue.cache;
}

export function openIssue(repo: Repo, input: Json, pull: Pull | null): Issue {
  const title = input.title;
  if (typeof title !== 'string' || title.trim() === '') throw invalid('Validation Failed', pull === null ? 'Issue' : 'PullRequest', 'title', 'missing_field');
  const labels = checkedLabels(repo, input.labels);
  const now = tick();
  touches += 1;
  repo.lastNumber += 1;
  const issue: Issue = {
    id: nextId(),
    number: repo.lastNumber,
    title,
    body: typeof input.body === 'string' ? input.body : '',
    state: 'open',
    stateReason: null,
    labels,
    comments: [],
    created: now,
    updated: now,
    closed: null,
    touched: touches,
    pull,
    cache: null,
  };
  repo.issues.set(issue.number, issue);
  nodes.set(nodeId(pull === null ? 'Issue' : 'PullRequest', issue.id), { kind: pull === null ? 'Issue' : 'PullRequest', repo, issue });
  return issue;
}

export function needIssue(repo: Repo, number: unknown): Issue {
  const n = typeof number === 'number' ? number : typeof number === 'string' && /^\d{1,15}$/.test(number) ? Number(number) : NaN;
  const issue = Number.isInteger(n) ? repo.issues.get(n) : undefined;
  if (issue === undefined) throw notFound();
  return issue;
}

export function setIssueState(issue: Issue, state: 'open' | 'closed', reason?: string | null): void {
  if (state === 'closed') {
    if (issue.state !== 'closed') issue.closed = tick();
    issue.state = 'closed';
    issue.stateReason = reason ?? (issue.pull === null ? 'completed' : null);
  } else {
    issue.state = 'open';
    issue.closed = null;
    issue.stateReason = issue.pull === null && reason === undefined ? null : reason ?? null;
  }
  touch(issue);
}

export function editIssue(repo: Repo, issue: Issue, input: Json): void {
  if (input.title !== undefined) {
    if (typeof input.title !== 'string' || input.title.trim() === '') throw invalid('Validation Failed', 'Issue', 'title');
    issue.title = input.title;
  }
  if (typeof input.body === 'string') issue.body = input.body;
  else if (input.body === null) issue.body = '';
  if (input.labels !== undefined) issue.labels = checkedLabels(repo, input.labels);
  if (input.state !== undefined) {
    if (input.state !== 'open' && input.state !== 'closed') throw invalid('Validation Failed', 'Issue', 'state');
    if (issue.pull !== null && issue.pull.merged && input.state === 'open') throw invalid('Validation Failed', 'PullRequest', 'state');
    const reason = typeof input.state_reason === 'string' ? input.state_reason : undefined;
    setIssueState(issue, input.state, reason);
    return;
  }
  touch(issue);
}

export interface IssueQuery {
  state?: string;
  sort?: string;
  direction?: string;
  labels?: string;
  /** true: pull requests only; false: issues only; undefined: both. */
  pulls?: boolean;
  head?: string;
  base?: string;
}

export function listIssues(repo: Repo, query: IssueQuery): Issue[] {
  const state = query.state ?? 'open';
  const wantedLabels = query.labels === undefined || query.labels === '' ? [] : query.labels.split(',').map((name) => name.trim().toLowerCase());
  const out: Issue[] = [];
  for (const issue of repo.issues.values()) {
    if (query.pulls === true && issue.pull === null) continue;
    if (query.pulls === false && issue.pull !== null) continue;
    if (state !== 'all' && issue.state !== state) continue;
    if (wantedLabels.length > 0 && !wantedLabels.every((name) => issue.labels.some((have) => have.toLowerCase() === name))) continue;
    if (query.head !== undefined && issue.pull !== null && issue.pull.head !== query.head.split(':').pop()) continue;
    if (query.base !== undefined && issue.pull !== null && issue.pull.base !== query.base) continue;
    out.push(issue);
  }
  const key = (issue: Issue): number => (query.sort === 'updated' ? issue.touched : query.sort === 'comments' ? issue.comments.length : issue.number);
  const sign = query.direction === 'asc' ? 1 : -1;
  out.sort((a, b) => sign * (key(a) - key(b)) || sign * (a.number - b.number));
  return out;
}

// ---------------------------------------------------------------- comments

export function commentJson(repo: Repo, issue: Issue, comment: Comment): Json {
  const root = api(`/repos/${viewer.login}/${repo.name}`);
  return {
    url: `${root}/issues/comments/${comment.id}`,
    html_url: `${site.origin}/${viewer.login}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    issue_url: `${root}/issues/${issue.number}`,
    id: comment.id,
    node_id: nodeId('IssueComment', comment.id),
    user: userJson(),
    created_at: comment.created,
    updated_at: comment.updated,
    author_association: 'OWNER',
    body: comment.body,
  };
}

export function addComment(repo: Repo, issue: Issue, input: Json): Comment {
  if (typeof input.body !== 'string' || input.body === '') throw invalid('Validation Failed', 'IssueComment', 'body', 'missing_field');
  const now = tick();
  const comment: Comment = { id: nextId(), body: input.body, created: now, updated: now };
  issue.comments.push(comment);
  nodes.set(nodeId('IssueComment', comment.id), { kind: 'IssueComment', repo, issue, comment });
  touch(issue);
  return comment;
}
