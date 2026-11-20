// The MCP tools: thin, schema-described wrappers over the same services REST and GraphQL use,
// so an object made by a tool is the object every other surface reads.

import { ApiError, type Json } from '../core/errors.ts';
import { viewer } from '../core/state.ts';
import {
  branchJson,
  branchTip,
  commitJson,
  createRef,
  createRepo,
  listBranches,
  listCommits,
  listRepos,
  needRepo,
  repoJson,
  resolveCommit,
  userJson,
} from '../core/repos.ts';
import { deleteContents, getContents, putContents } from '../core/contents.ts';
import { addComment, commentJson, createLabel, editIssue, issueJson, labelJson, listIssues, needIssue, openIssue } from '../core/issues.ts';
import { editPull, mergePull, needPull, openPull, pullFilesJson, pullJson } from '../core/pulls.ts';

type Props = Record<string, { type: string | string[]; description: string; enum?: string[]; items?: { type: string } }>;

export interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: { type: 'object'; properties: Props; required: string[]; additionalProperties: boolean };
  annotations: { readOnlyHint: boolean };
  run: (args: Json) => unknown;
}

const OWNER = { type: 'string', description: 'Repository owner (the account login)' };
const REPO = { type: 'string', description: 'Repository name' };
const PAGE = { type: 'number', description: 'Page number for pagination (min 1)' };
const PER_PAGE = { type: 'number', description: 'Results per page (min 1, max 100)' };

function text(args: Json, key: string): string | undefined {
  const value = args[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function repoOf(args: Json) {
  const owner = text(args, 'owner') ?? viewer.login;
  return needRepo(owner, text(args, 'repo') ?? '');
}

function window<T>(items: T[], args: Json): T[] {
  const perPage = Math.min(100, Math.max(1, Number(args.per_page ?? args.perPage ?? 30) || 30));
  const page = Math.max(1, Number(args.page ?? 1) || 1);
  return items.slice((page - 1) * perPage, page * perPage);
}

function tool(name: string, title: string, description: string, properties: Props, required: string[], readOnly: boolean, run: (args: Json) => unknown): Tool {
  return { name, title, description, inputSchema: { type: 'object', properties, required, additionalProperties: false }, annotations: { readOnlyHint: readOnly }, run };
}

export const TOOLS: Tool[] = [
  tool('get_me', 'Get my user profile', 'Get details of the authenticated user: the account the access token belongs to.', {}, [], true, () => userJson()),
  tool(
    'create_repo',
    'Create repository',
    'Create a new repository in the authenticated account.',
    {
      name: { type: 'string', description: 'Repository name' },
      description: { type: 'string', description: 'Repository description' },
      private: { type: 'boolean', description: 'Whether the repository is private' },
      auto_init: { type: 'boolean', description: 'Initialize the repository with a README' },
    },
    ['name'],
    false,
    (args) => repoJson(createRepo(args)),
  ),
  tool('get_repo', 'Get repository', 'Get one repository by owner and name.', { owner: OWNER, repo: REPO }, ['owner', 'repo'], true, (args) => repoJson(repoOf(args))),
  tool('list_repos', 'List repositories', 'List the repositories of the authenticated account.', { page: PAGE, per_page: PER_PAGE }, [], true, (args) =>
    window(listRepos(), args).map(repoJson),
  ),
  tool(
    'create_issue',
    'Open new issue',
    'Create a new issue in a repository.',
    {
      owner: OWNER,
      repo: REPO,
      title: { type: 'string', description: 'Issue title' },
      body: { type: 'string', description: 'Issue body content' },
      labels: { type: 'array', description: 'Labels to apply to the issue (they must exist in the repository)', items: { type: 'string' } },
    },
    ['owner', 'repo', 'title'],
    false,
    (args) => {
      const repo = repoOf(args);
      return issueJson(repo, openIssue(repo, args, null));
    },
  ),
  tool('get_issue', 'Get issue details', 'Get one issue of a repository by its number.', { owner: OWNER, repo: REPO, issue_number: { type: 'number', description: 'Issue number' } }, ['owner', 'repo', 'issue_number'], true, (args) => {
    const repo = repoOf(args);
    return issueJson(repo, needIssue(repo, text(args, 'issue_number')));
  }),
  tool(
    'list_issues',
    'List issues',
    'List the issues of a repository, filtered by state and labels.',
    {
      owner: OWNER,
      repo: REPO,
      state: { type: 'string', description: 'Filter by state', enum: ['open', 'closed', 'all'] },
      labels: { type: 'array', description: 'Filter by labels', items: { type: 'string' } },
      sort: { type: 'string', description: 'Sort by', enum: ['created', 'updated', 'comments'] },
      direction: { type: 'string', description: 'Sort direction', enum: ['asc', 'desc'] },
      page: PAGE,
      per_page: PER_PAGE,
    },
    ['owner', 'repo'],
    true,
    (args) => {
      const repo = repoOf(args);
      const state = (text(args, 'state') ?? 'open').toLowerCase();
      const found = listIssues(repo, {
        state,
        sort: text(args, 'sort'),
        direction: text(args, 'direction')?.toLowerCase(),
        labels: Array.isArray(args.labels) ? args.labels.join(',') : text(args, 'labels'),
        pulls: false,
      });
      return window(found, args).map((issue) => issueJson(repo, issue));
    },
  ),
  tool(
    'update_issue',
    'Edit issue',
    'Update the title, body, state or labels of an existing issue.',
    {
      owner: OWNER,
      repo: REPO,
      issue_number: { type: 'number', description: 'Issue number to update' },
      title: { type: 'string', description: 'New title' },
      body: { type: 'string', description: 'New body' },
      state: { type: 'string', description: 'New state', enum: ['open', 'closed'] },
      labels: { type: 'array', description: 'New labels', items: { type: 'string' } },
    },
    ['owner', 'repo', 'issue_number'],
    false,
    (args) => {
      const repo = repoOf(args);
      const issue = needIssue(repo, text(args, 'issue_number'));
      editIssue(repo, issue, { title: args.title, body: args.body, state: args.state, labels: args.labels });
      return issueJson(repo, issue);
    },
  ),
  tool(
    'add_issue_comment',
    'Add comment to issue',
    'Add a comment to an issue or pull request.',
    { owner: OWNER, repo: REPO, issue_number: { type: 'number', description: 'Issue or pull request number' }, body: { type: 'string', description: 'Comment content' } },
    ['owner', 'repo', 'issue_number', 'body'],
    false,
    (args) => {
      const repo = repoOf(args);
      const issue = needIssue(repo, text(args, 'issue_number'));
      return commentJson(repo, issue, addComment(repo, issue, args));
    },
  ),
  tool('create_label', 'Create label', 'Create a label in a repository so issues can carry it.', { owner: OWNER, repo: REPO, name: { type: 'string', description: 'Label name' }, color: { type: 'string', description: 'Six-digit hex color' }, description: { type: 'string', description: 'Label description' } }, ['owner', 'repo', 'name'], false, (args) => {
    const repo = repoOf(args);
    return labelJson(repo, createLabel(repo, args));
  }),
  tool(
    'create_pull_request',
    'Open new pull request',
    'Create a new pull request from a head branch into a base branch.',
    {
      owner: OWNER,
      repo: REPO,
      title: { type: 'string', description: 'Pull request title' },
      body: { type: 'string', description: 'Pull request description' },
      head: { type: 'string', description: 'Branch containing the changes' },
      base: { type: 'string', description: 'Branch to merge into' },
      draft: { type: 'boolean', description: 'Create as a draft pull request' },
    },
    ['owner', 'repo', 'title', 'head', 'base'],
    false,
    (args) => {
      const repo = repoOf(args);
      return pullJson(repo, openPull(repo, args), true);
    },
  ),
  tool('get_pull_request', 'Get pull request details', 'Get one pull request of a repository by its number.', { owner: OWNER, repo: REPO, pull_number: { type: 'number', description: 'Pull request number' } }, ['owner', 'repo', 'pull_number'], true, (args) => {
    const repo = repoOf(args);
    return pullJson(repo, needPull(repo, text(args, 'pull_number')), true);
  }),
  tool(
    'list_pull_requests',
    'List pull requests',
    'List the pull requests of a repository.',
    { owner: OWNER, repo: REPO, state: { type: 'string', description: 'Filter by state', enum: ['open', 'closed', 'all'] }, head: { type: 'string', description: 'Filter by head branch' }, base: { type: 'string', description: 'Filter by base branch' }, page: PAGE, per_page: PER_PAGE },
    ['owner', 'repo'],
    true,
    (args) => {
      const repo = repoOf(args);
      const found = listIssues(repo, { state: (text(args, 'state') ?? 'open').toLowerCase(), head: text(args, 'head'), base: text(args, 'base'), pulls: true });
      return window(found, args).map((issue) => pullJson(repo, issue, false));
    },
  ),
  tool('get_pull_request_files', 'Get pull request files', 'List the files a pull request changes.', { owner: OWNER, repo: REPO, pull_number: { type: 'number', description: 'Pull request number' } }, ['owner', 'repo', 'pull_number'], true, (args) => {
    const repo = repoOf(args);
    return pullFilesJson(repo, needPull(repo, text(args, 'pull_number')));
  }),
  tool(
    'update_pull_request',
    'Edit pull request',
    'Update the title, body, base branch or state of a pull request.',
    { owner: OWNER, repo: REPO, pull_number: { type: 'number', description: 'Pull request number' }, title: { type: 'string', description: 'New title' }, body: { type: 'string', description: 'New description' }, state: { type: 'string', description: 'New state', enum: ['open', 'closed'] }, base: { type: 'string', description: 'New base branch' } },
    ['owner', 'repo', 'pull_number'],
    false,
    (args) => {
      const repo = repoOf(args);
      const issue = needPull(repo, text(args, 'pull_number'));
      editPull(repo, issue, args);
      return pullJson(repo, issue, true);
    },
  ),
  tool(
    'merge_pull_request',
    'Merge pull request',
    'Merge a pull request into its base branch.',
    {
      owner: OWNER,
      repo: REPO,
      pull_number: { type: 'number', description: 'Pull request number' },
      merge_method: { type: 'string', description: 'Merge method', enum: ['merge', 'squash', 'rebase'] },
      commit_title: { type: 'string', description: 'Title for the merge commit' },
      commit_message: { type: 'string', description: 'Extra detail for the merge commit' },
    },
    ['owner', 'repo', 'pull_number'],
    false,
    (args) => {
      const repo = repoOf(args);
      return mergePull(repo, needPull(repo, text(args, 'pull_number')), args);
    },
  ),
  tool('list_branches', 'List branches', 'List the branches of a repository.', { owner: OWNER, repo: REPO, page: PAGE, per_page: PER_PAGE }, ['owner', 'repo'], true, (args) => window(listBranches(repoOf(args)), args)),
  tool(
    'create_branch',
    'Create branch',
    'Create a new branch in a repository from an existing branch.',
    { owner: OWNER, repo: REPO, branch: { type: 'string', description: 'Name for the new branch' }, from_branch: { type: 'string', description: 'Source branch (defaults to the repository default branch)' } },
    ['owner', 'repo', 'branch'],
    false,
    (args) => {
      const repo = repoOf(args);
      const from = text(args, 'from_branch') ?? repo.defaultBranch;
      const sha = branchTip(repo, from);
      if (sha === undefined) throw new ApiError(404, `Branch ${from} not found`);
      return createRef(repo, { ref: `refs/heads/${text(args, 'branch') ?? ''}`, sha });
    },
  ),
  tool('list_commits', 'List commits', 'List the commits of a branch, tag or commit of a repository.', { owner: OWNER, repo: REPO, sha: { type: 'string', description: 'Branch name, tag or commit SHA to start from' }, page: PAGE, per_page: PER_PAGE }, ['owner', 'repo'], true, (args) => {
    const repo = repoOf(args);
    return window(listCommits(repo, text(args, 'sha')), args).map((oid) => commitJson(repo, oid));
  }),
  tool('get_commit', 'Get commit details', 'Get one commit of a repository by branch name, tag or SHA.', { owner: OWNER, repo: REPO, sha: { type: 'string', description: 'Commit SHA, branch name or tag name' } }, ['owner', 'repo', 'sha'], true, (args) => {
    const repo = repoOf(args);
    const oid = resolveCommit(repo, text(args, 'sha'));
    if (oid === null) throw new ApiError(404, 'Not Found');
    return commitJson(repo, oid);
  }),
  tool('get_branch', 'Get branch', 'Get one branch of a repository and the commit it points at.', { owner: OWNER, repo: REPO, branch: { type: 'string', description: 'Branch name' } }, ['owner', 'repo', 'branch'], true, (args) => {
    const repo = repoOf(args);
    const name = text(args, 'branch') ?? '';
    const tip = branchTip(repo, name);
    if (tip === undefined) throw new ApiError(404, 'Branch not found');
    return branchJson(repo, name, tip, true);
  }),
  tool(
    'get_file_contents',
    'Get file or directory contents',
    'Get the contents of a file or a directory listing from a repository.',
    { owner: OWNER, repo: REPO, path: { type: 'string', description: 'Path to the file or directory' }, ref: { type: 'string', description: 'Branch, tag or commit SHA' } },
    ['owner', 'repo'],
    true,
    (args) => getContents(repoOf(args), text(args, 'path') ?? '', text(args, 'ref') ?? text(args, 'branch')),
  ),
  tool(
    'create_or_update_file',
    'Create or update file',
    'Create or update a single file in a repository as a commit. Updating needs the current blob SHA.',
    {
      owner: OWNER,
      repo: REPO,
      path: { type: 'string', description: 'Path where to create or update the file' },
      content: { type: 'string', description: 'Content of the file (plain text)' },
      message: { type: 'string', description: 'Commit message' },
      branch: { type: 'string', description: 'Branch to commit to' },
      sha: { type: 'string', description: 'Blob SHA of the file being replaced' },
    },
    ['owner', 'repo', 'path', 'content', 'message'],
    false,
    (args) => putContents(repoOf(args), text(args, 'path') ?? '', { ...args, content: Buffer.from(text(args, 'content') ?? '', 'utf8').toString('base64') }).body,
  ),
  tool(
    'delete_file',
    'Delete file',
    'Delete a file from a repository as a commit.',
    { owner: OWNER, repo: REPO, path: { type: 'string', description: 'Path to the file to delete' }, message: { type: 'string', description: 'Commit message' }, branch: { type: 'string', description: 'Branch to delete the file from' }, sha: { type: 'string', description: 'Blob SHA of the file being deleted' } },
    ['owner', 'repo', 'path', 'message'],
    false,
    (args) => {
      const repo = repoOf(args);
      const path = text(args, 'path') ?? '';
      let sha = text(args, 'sha');
      if (sha === undefined) {
        const current = getContents(repo, path, text(args, 'branch'));
        if (!Array.isArray(current)) sha = String(current.sha);
      }
      return deleteContents(repo, path, { ...args, sha });
    },
  ),
];

export const TOOL_BY_NAME = new Map(TOOLS.map((item) => [item.name, item]));
