// Pull requests: opening one between two branches, listing what it changes, and merging it.

import { ApiError, invalid, notFound, type Json } from './errors.ts';
import { issueJson, openIssue, setIssueState, touch } from './issues.ts';
import { api, branchTip, ident, repoJson, setRef, userJson } from './repos.ts';
import { clockSeconds, site, tick, viewer, type Issue, type Pull, type Repo } from './state.ts';
import { commitInfo, getObject, writeCommit } from '../git/objects.ts';
import { history, isAncestor, mergeBase } from '../git/graph.ts';
import { diffTrees, lineStat, mergeTrees, type FileChange } from '../git/tree.ts';

function branchName(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  const bare = value.includes(':') ? value.slice(value.indexOf(':') + 1) : value;
  return bare.startsWith('refs/heads/') ? bare.slice(11) : bare;
}

/** The tips a pull request compares right now: live branches while open, the recorded ones after. */
export function pullTips(repo: Repo, issue: Issue): { head: string; base: string } {
  const pull = issue.pull!;
  if (issue.state === 'open') {
    const head = branchTip(repo, pull.head);
    const base = branchTip(repo, pull.base);
    if (head !== undefined) pull.headSha = head;
    if (base !== undefined) pull.baseSha = base;
  }
  return { head: pull.headSha, base: pull.baseSha };
}

function treeOf(commit: string | null): string | null {
  return commit === null || getObject(commit) === undefined ? null : commitInfo(commit).tree;
}

/** The merged tree of a pull request's two sides, or null when they conflict. */
function mergedTree(tips: { head: string; base: string }): string | null {
  const ancestor = mergeBase(tips.base, tips.head);
  return mergeTrees(treeOf(ancestor), commitInfo(tips.base).tree, commitInfo(tips.head).tree);
}

export function isMergeable(repo: Repo, issue: Issue): boolean {
  if (issue.state !== 'open') return false;
  return mergedTree(pullTips(repo, issue)) !== null;
}

export function pullChanges(repo: Repo, issue: Issue): FileChange[] {
  const tips = pullTips(repo, issue);
  return diffTrees(treeOf(mergeBase(tips.base, tips.head)), treeOf(tips.head));
}

export function pullFilesJson(repo: Repo, issue: Issue): Json[] {
  const tips = pullTips(repo, issue);
  const root = api(`/repos/${viewer.login}/${repo.name}`);
  return pullChanges(repo, issue).map((change) => {
    const stat = lineStat(change.before, change.after);
    const encoded = change.path.split('/').map(encodeURIComponent).join('/');
    return {
      sha: change.after ?? change.before,
      filename: change.path,
      status: change.status,
      additions: stat.additions,
      deletions: stat.deletions,
      changes: stat.additions + stat.deletions,
      blob_url: `${site.origin}/${viewer.login}/${repo.name}/blob/${tips.head}/${encoded}`,
      raw_url: `${site.origin}/${viewer.login}/${repo.name}/raw/${tips.head}/${encoded}`,
      contents_url: `${root}/contents/${encoded}?ref=${tips.head}`,
    };
  });
}

function sideJson(repo: Repo, branch: string, sha: string): Json {
  return { label: `${viewer.login}:${branch}`, ref: branch, sha, user: userJson(), repo: repoJson(repo) };
}

export function pullJson(repo: Repo, issue: Issue, detail: boolean): Json {
  const pull = issue.pull!;
  const tips = pullTips(repo, issue);
  const root = api(`/repos/${viewer.login}/${repo.name}`);
  const html = `${site.origin}/${viewer.login}/${repo.name}/pull/${issue.number}`;
  const base = issueJson(repo, issue);
  const out: Json = {
    url: `${root}/pulls/${issue.number}`,
    id: issue.id,
    node_id: base.node_id,
    html_url: html,
    diff_url: `${html}.diff`,
    patch_url: `${html}.patch`,
    issue_url: `${root}/issues/${issue.number}`,
    commits_url: `${root}/pulls/${issue.number}/commits`,
    review_comments_url: `${root}/pulls/${issue.number}/comments`,
    comments_url: `${root}/issues/${issue.number}/comments`,
    statuses_url: `${root}/statuses/${tips.head}`,
    number: issue.number,
    state: issue.state,
    locked: false,
    title: issue.title,
    user: userJson(),
    body: issue.body,
    labels: base.labels,
    milestone: null,
    created_at: issue.created,
    updated_at: issue.updated,
    closed_at: issue.closed,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeSha,
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    requested_teams: [],
    draft: pull.draft,
    head: sideJson(repo, pull.head, tips.head),
    base: sideJson(repo, pull.base, tips.base),
    author_association: 'OWNER',
    auto_merge: null,
    merged: pull.merged,
  };
  if (detail) {
    const mergeable = issue.state === 'open' ? isMergeable(repo, issue) : null;
    const changes = pullChanges(repo, issue);
    let additions = 0;
    let deletions = 0;
    for (const change of changes) {
      const stat = lineStat(change.before, change.after);
      additions += stat.additions;
      deletions += stat.deletions;
    }
    out.mergeable = mergeable;
    out.rebaseable = mergeable;
    out.mergeable_state = mergeable === null ? 'unknown' : mergeable ? 'clean' : 'dirty';
    out.merged_by = pull.merged ? userJson() : null;
    out.comments = issue.comments.length;
    out.review_comments = 0;
    out.maintainer_can_modify = false;
    out.commits = history(tips.head).filter((oid) => !isAncestor(oid, tips.base)).length;
    out.additions = additions;
    out.deletions = deletions;
    out.changed_files = changes.length;
  }
  return out;
}

export function needPull(repo: Repo, number: unknown): Issue {
  const n = typeof number === 'number' ? number : typeof number === 'string' && /^\d{1,15}$/.test(number) ? Number(number) : NaN;
  const issue = Number.isInteger(n) ? repo.issues.get(n) : undefined;
  if (issue === undefined || issue.pull === null) throw notFound();
  return issue;
}

export function openPull(repo: Repo, input: Json): Issue {
  const head = branchName(input.head);
  const base = branchName(input.base);
  if (head === undefined) throw invalid('Validation Failed', 'PullRequest', 'head', 'missing_field');
  if (base === undefined) throw invalid('Validation Failed', 'PullRequest', 'base', 'missing_field');
  const headSha = branchTip(repo, head);
  const baseSha = branchTip(repo, base);
  if (headSha === undefined) throw invalid('Validation Failed', 'PullRequest', 'head', 'invalid');
  if (baseSha === undefined) throw invalid('Validation Failed', 'PullRequest', 'base', 'invalid');
  if (head === base || isAncestor(headSha, baseSha)) {
    throw new ApiError(422, 'Validation Failed', [{ resource: 'PullRequest', code: 'custom', message: `No commits between ${base} and ${head}` }]);
  }
  for (const other of repo.issues.values()) {
    if (other.pull !== null && other.state === 'open' && other.pull.head === head && other.pull.base === base) {
      throw new ApiError(422, 'Validation Failed', [{ resource: 'PullRequest', code: 'custom', message: `A pull request already exists for ${viewer.login}:${head}.` }]);
    }
  }
  const pull: Pull = { head, base, headSha, baseSha, merged: false, mergedAt: null, mergeSha: null, draft: input.draft === true };
  return openIssue(repo, input, pull);
}

export function editPull(repo: Repo, issue: Issue, input: Json): void {
  if (typeof input.title === 'string' && input.title.trim() !== '') issue.title = input.title;
  if (typeof input.body === 'string') issue.body = input.body;
  if (typeof input.base === 'string' && branchTip(repo, input.base) !== undefined && issue.state === 'open') issue.pull!.base = input.base;
  if (input.state === 'closed' || input.state === 'open') {
    if (issue.pull!.merged && input.state === 'open') throw invalid('Validation Failed', 'PullRequest', 'state');
    pullTips(repo, issue);
    setIssueState(issue, input.state, null);
    return;
  }
  touch(issue);
}

export interface MergeResult {
  sha: string;
  merged: true;
  message: string;
}

/** Merge a pull request into its base branch. 405 when it cannot be merged, 409 on a stale `sha`. */
export function mergePull(repo: Repo, issue: Issue, input: Json): MergeResult {
  const pull = issue.pull!;
  if (pull.merged || issue.state !== 'open') throw new ApiError(405, 'Pull Request is not mergeable');
  const tips = pullTips(repo, issue);
  if (branchTip(repo, pull.head) === undefined || branchTip(repo, pull.base) === undefined) throw new ApiError(405, 'Pull Request is not mergeable');
  if (typeof input.sha === 'string' && input.sha.toLowerCase() !== tips.head) throw new ApiError(409, 'Head branch was modified. Review and try the merge again.');
  const method = typeof input.merge_method === 'string' ? input.merge_method.toLowerCase() : 'merge';
  if (method !== 'merge' && method !== 'squash' && method !== 'rebase') throw invalid('Validation Failed', 'PullRequest', 'merge_method');
  const tree = mergedTree(tips);
  if (tree === null) throw new ApiError(405, 'Pull Request is not mergeable');
  const title = typeof input.commit_title === 'string' && input.commit_title !== '' ? input.commit_title : method === 'merge' ? `Merge pull request #${issue.number} from ${viewer.login}/${pull.head}` : `${issue.title} (#${issue.number})`;
  const detail = typeof input.commit_message === 'string' ? input.commit_message : method === 'merge' ? issue.title : issue.body;
  const message = detail === '' ? title : `${title}\n\n${detail}`;
  tick();
  const parents = method === 'merge' ? [tips.base, tips.head] : [tips.base];
  const sha = writeCommit({ tree, parents, who: ident(), when: clockSeconds(), message });
  setRef(repo, `refs/heads/${pull.base}`, sha);
  pull.merged = true;
  pull.mergedAt = tick();
  pull.mergeSha = sha;
  pull.headSha = tips.head;
  pull.baseSha = tips.base;
  setIssueState(issue, 'closed', null);
  return { sha, merged: true, message: 'Pull Request successfully merged' };
}

export function needPullOr404(repo: Repo, number: unknown): Issue {
  try {
    return needPull(repo, number);
  } catch {
    throw notFound();
  }
}
