// The GraphQL v4 schema the forge serves: the types gh and github-mcp-server read, each field
// with the resolver that answers it from the same store REST uses.

import { ApiError } from '../core/errors.ts';
import { findRepo, nodeId, nodes, site, viewer, type Comment, type Issue, type Label, type Repo } from '../core/state.ts';
import { branchTip, createRepo, listRepos, shownMessage } from '../core/repos.ts';
import { addComment, editIssue, listIssues, openIssue, setIssueState } from '../core/issues.ts';
import { editPull, isMergeable, mergePull, openPull, pullChanges, pullTips } from '../core/pulls.ts';
import { commitInfo, getObject, parseIdent, peelToCommit } from '../git/objects.ts';
import { history, isAncestor } from '../git/graph.ts';
import { lineStat } from '../git/tree.ts';
import { isoOf } from '../core/state.ts';
import { PAGING, addConnection, connection, type Args, type Schema } from './types.ts';

interface IssueNode {
  __type: 'Issue' | 'PullRequest';
  repo: Repo;
  issue: Issue;
}

interface CommentNode {
  __type: 'IssueComment';
  repo: Repo;
  issue: Issue;
  comment: Comment;
}

interface RefNode {
  repo: Repo;
  ref: string;
  oid: string;
}

interface CommitNode {
  repo: Repo;
  oid: string;
}

const USER = { __type: 'User' };

function issueNode(repo: Repo, issue: Issue): IssueNode {
  return { __type: issue.pull === null ? 'Issue' : 'PullRequest', repo, issue };
}

function repoUrl(repo: Repo): string {
  return `${site.origin}/${viewer.login}/${repo.name}`;
}

/** What a global id names, as a typed source value; null when nothing does. */
function nodeOf(id: unknown): unknown {
  if (typeof id !== 'string') return null;
  const hit = nodes.get(id);
  if (hit === undefined) return id === nodeId('User', viewer.id) ? USER : null;
  if (hit.kind === 'Repository') return Object.assign(hit.repo!, { __type: 'Repository' });
  if (hit.kind === 'Issue' || hit.kind === 'PullRequest') return issueNode(hit.repo!, hit.issue!);
  if (hit.kind === 'IssueComment') return { __type: 'IssueComment', repo: hit.repo!, issue: hit.issue!, comment: hit.comment! };
  if (hit.kind === 'Label') return { __type: 'Label', repo: hit.repo!, label: hit.label! };
  return null;
}

function needNode<T>(id: unknown, kinds: string[]): T {
  const node = nodeOf(id) as { __type?: string } | null;
  if (node === null || node.__type === undefined || !kinds.includes(node.__type)) {
    throw new ApiError(404, `Could not resolve to a node with the global id of '${String(id)}'`);
  }
  return node as T;
}

function states(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  return (Array.isArray(value) ? value : [value]).map((state) => String(state).toUpperCase());
}

function issuesOf(repo: Repo, args: Args, pulls: boolean): IssueNode[] {
  const wanted = states(args.states);
  const order = args.orderBy ?? {};
  const field = String(order.field ?? 'CREATED_AT').toUpperCase();
  const found = listIssues(repo, {
    state: 'all',
    pulls,
    sort: field === 'UPDATED_AT' ? 'updated' : field === 'COMMENTS' ? 'comments' : 'created',
    direction: String(order.direction ?? 'ASC').toUpperCase() === 'DESC' ? 'desc' : 'asc',
    labels: Array.isArray(args.labels) ? args.labels.join(',') : undefined,
  }).filter((issue) => {
    if (wanted !== null && !wanted.includes(stateOf(issue))) return false;
    if (pulls && typeof args.headRefName === 'string' && issue.pull!.head !== args.headRefName) return false;
    if (pulls && typeof args.baseRefName === 'string' && issue.pull!.base !== args.baseRefName) return false;
    return true;
  });
  return found.map((issue) => issueNode(repo, issue));
}

function stateOf(issue: Issue): string {
  if (issue.pull !== null && issue.pull.merged) return 'MERGED';
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function commitNode(repo: Repo, oid: string | null | undefined): CommitNode | null {
  return oid === null || oid === undefined || getObject(oid) === undefined ? null : { repo, oid };
}

function filesOf(node: IssueNode): { path: string; additions: number; deletions: number; changeType: string }[] {
  return pullChanges(node.repo, node.issue).map((change) => {
    const stat = lineStat(change.before, change.after);
    return {
      path: change.path,
      additions: stat.additions,
      deletions: stat.deletions,
      changeType: change.status === 'added' ? 'ADDED' : change.status === 'removed' ? 'DELETED' : 'MODIFIED',
    };
  });
}

/** Fields an issue and a pull request share. */
function commonIssueFields(kind: 'issues' | 'pull'): Schema[string]['fields'] {
  return {
    id: { type: 'ID!', resolve: (n: IssueNode) => nodeId(n.__type, n.issue.id) },
    databaseId: { type: 'Int', resolve: (n: IssueNode) => n.issue.id },
    fullDatabaseId: { type: 'String', resolve: (n: IssueNode) => String(n.issue.id) },
    number: { type: 'Int!', resolve: (n: IssueNode) => n.issue.number },
    title: { type: 'String!', resolve: (n: IssueNode) => n.issue.title },
    body: { type: 'String!', resolve: (n: IssueNode) => n.issue.body },
    bodyText: { type: 'String!', resolve: (n: IssueNode) => n.issue.body },
    bodyHTML: { type: 'String!', resolve: (n: IssueNode) => n.issue.body },
    state: { type: kind === 'pull' ? 'PullRequestState!' : 'IssueState!', resolve: (n: IssueNode) => stateOf(n.issue) },
    closed: { type: 'Boolean!', resolve: (n: IssueNode) => n.issue.state === 'closed' },
    closedAt: { type: 'DateTime', resolve: (n: IssueNode) => n.issue.closed },
    createdAt: { type: 'DateTime!', resolve: (n: IssueNode) => n.issue.created },
    updatedAt: { type: 'DateTime!', resolve: (n: IssueNode) => n.issue.updated },
    url: { type: 'URI!', resolve: (n: IssueNode) => `${repoUrl(n.repo)}/${kind}/${n.issue.number}` },
    resourcePath: { type: 'URI!', resolve: (n: IssueNode) => `/${viewer.login}/${n.repo.name}/${kind}/${n.issue.number}` },
    author: { type: 'Actor', resolve: () => USER },
    authorAssociation: { type: 'String!', resolve: () => 'OWNER' },
    repository: { type: 'Repository!', resolve: (n: IssueNode) => n.repo },
    locked: { type: 'Boolean!', resolve: () => false },
    viewerDidAuthor: { type: 'Boolean!', resolve: () => true },
    viewerCanUpdate: { type: 'Boolean!', resolve: () => true },
    labels: {
      type: 'LabelConnection',
      args: PAGING,
      resolve: (n: IssueNode, args) => connection(n.issue.labels.map((name) => ({ __type: 'Label', repo: n.repo, label: n.repo.labels.get(name.toLowerCase())! })), args),
    },
    comments: {
      type: 'IssueCommentConnection!',
      args: PAGING,
      resolve: (n: IssueNode, args) => connection(n.issue.comments.map((comment): CommentNode => ({ __type: 'IssueComment', repo: n.repo, issue: n.issue, comment })), args),
    },
    assignees: { type: 'UserConnection!', args: PAGING, resolve: (_n, args) => connection([], args) },
    milestone: { type: 'String', resolve: () => null },
  };
}

function ownerFields(): Schema[string]['fields'] {
  return {
    id: { type: 'ID!', resolve: () => nodeId('User', viewer.id) },
    databaseId: { type: 'Int', resolve: () => viewer.id },
    login: { type: 'String!', resolve: () => viewer.login },
    name: { type: 'String', resolve: () => viewer.login },
    email: { type: 'String!', resolve: () => '' },
    url: { type: 'URI!', resolve: () => `${site.origin}/${viewer.login}` },
    resourcePath: { type: 'URI!', resolve: () => `/${viewer.login}` },
    avatarUrl: { type: 'URI!', args: { size: 'Int' }, resolve: () => `${site.origin}/avatars/${viewer.login}` },
    isViewer: { type: 'Boolean!', resolve: () => true },
    repositories: {
      type: 'RepositoryConnection!',
      args: { ...PAGING, orderBy: 'RepositoryOrder', privacy: 'RepositoryPrivacy', isFork: 'Boolean', ownerAffiliations: '[RepositoryAffiliation]', affiliations: '[RepositoryAffiliation]' },
      resolve: (_n, args) => connection(listRepos(), args),
    },
    repository: { type: 'Repository', args: { name: 'String!' }, resolve: (_n, args) => findRepo(viewer.login, String(args.name)) ?? null },
    organizations: { type: 'OrganizationConnection!', args: PAGING, resolve: (_n, args) => connection([], args) },
  };
}

export const schema: Schema = {
  // ------------------------------------------------------------ scalars and enums
  String: { kind: 'SCALAR' },
  Int: { kind: 'SCALAR' },
  Float: { kind: 'SCALAR' },
  Boolean: { kind: 'SCALAR' },
  ID: { kind: 'SCALAR' },
  DateTime: { kind: 'SCALAR' },
  URI: { kind: 'SCALAR' },
  HTML: { kind: 'SCALAR' },
  GitObjectID: { kind: 'SCALAR' },
  IssueState: { kind: 'ENUM', values: ['OPEN', 'CLOSED'] },
  IssueStateReason: { kind: 'ENUM', values: ['REOPENED', 'NOT_PLANNED', 'COMPLETED', 'DUPLICATE'] },
  IssueClosedStateReason: { kind: 'ENUM', values: ['COMPLETED', 'NOT_PLANNED', 'DUPLICATE'] },
  PullRequestState: { kind: 'ENUM', values: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', values: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  PullRequestMergeMethod: { kind: 'ENUM', values: ['MERGE', 'SQUASH', 'REBASE'] },
  RepositoryPermission: { kind: 'ENUM', values: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  RepositoryVisibility: { kind: 'ENUM', values: ['PRIVATE', 'PUBLIC', 'INTERNAL'] },
  RepositoryPrivacy: { kind: 'ENUM', values: ['PUBLIC', 'PRIVATE'] },
  RepositoryAffiliation: { kind: 'ENUM', values: ['OWNER', 'COLLABORATOR', 'ORGANIZATION_MEMBER'] },
  RepositoryOrderField: { kind: 'ENUM', values: ['CREATED_AT', 'UPDATED_AT', 'PUSHED_AT', 'NAME', 'STARGAZERS'] },
  SearchType: { kind: 'ENUM', values: ['ISSUE', 'ISSUE_ADVANCED', 'REPOSITORY', 'USER', 'DISCUSSION'] },
  IssueOrderField: { kind: 'ENUM', values: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', values: ['ASC', 'DESC'] },
  PatchStatus: { kind: 'ENUM', values: ['ADDED', 'DELETED', 'RENAMED', 'COPIED', 'MODIFIED', 'CHANGED'] },

  // ------------------------------------------------------------ inputs
  IssueOrder: { kind: 'INPUT_OBJECT', inputFields: { field: 'IssueOrderField!', direction: 'OrderDirection!' } },
  RepositoryOrder: { kind: 'INPUT_OBJECT', inputFields: { field: 'RepositoryOrderField!', direction: 'OrderDirection!' } },
  IssueFilters: { kind: 'INPUT_OBJECT', inputFields: { states: '[IssueState!]', labels: '[String!]', assignee: 'String', createdBy: 'String', mentioned: 'String' } },
  CreateIssueInput: { kind: 'INPUT_OBJECT', inputFields: { repositoryId: 'ID!', title: 'String!', body: 'String', labelIds: '[ID!]', assigneeIds: '[ID!]', clientMutationId: 'String' } },
  UpdateIssueInput: { kind: 'INPUT_OBJECT', inputFields: { id: 'ID!', title: 'String', body: 'String', state: 'IssueState', clientMutationId: 'String' } },
  CloseIssueInput: { kind: 'INPUT_OBJECT', inputFields: { issueId: 'ID!', stateReason: 'IssueClosedStateReason', clientMutationId: 'String' } },
  ReopenIssueInput: { kind: 'INPUT_OBJECT', inputFields: { issueId: 'ID!', clientMutationId: 'String' } },
  AddCommentInput: { kind: 'INPUT_OBJECT', inputFields: { subjectId: 'ID!', body: 'String!', clientMutationId: 'String' } },
  CreatePullRequestInput: {
    kind: 'INPUT_OBJECT',
    inputFields: { repositoryId: 'ID!', baseRefName: 'String!', headRefName: 'String!', title: 'String!', body: 'String', draft: 'Boolean', headRepositoryId: 'ID', maintainerCanModify: 'Boolean', clientMutationId: 'String' },
  },
  UpdatePullRequestInput: { kind: 'INPUT_OBJECT', inputFields: { pullRequestId: 'ID!', title: 'String', body: 'String', baseRefName: 'String', state: 'PullRequestState', clientMutationId: 'String' } },
  MergePullRequestInput: {
    kind: 'INPUT_OBJECT',
    inputFields: { pullRequestId: 'ID!', mergeMethod: 'PullRequestMergeMethod', commitHeadline: 'String', commitBody: 'String', expectedHeadOid: 'GitObjectID', authorEmail: 'String', clientMutationId: 'String' },
  },
  ClosePullRequestInput: { kind: 'INPUT_OBJECT', inputFields: { pullRequestId: 'ID!', clientMutationId: 'String' } },
  ReopenPullRequestInput: { kind: 'INPUT_OBJECT', inputFields: { pullRequestId: 'ID!', clientMutationId: 'String' } },
  CreateRepositoryInput: { kind: 'INPUT_OBJECT', inputFields: { name: 'String!', description: 'String', visibility: 'RepositoryVisibility!', ownerId: 'ID', clientMutationId: 'String' } },

  // ------------------------------------------------------------ interfaces and unions
  Node: { kind: 'INTERFACE', fields: { id: { type: 'ID!' } }, possible: ['Repository', 'Issue', 'PullRequest', 'IssueComment', 'User', 'Label'] },
  Actor: {
    kind: 'INTERFACE',
    fields: { login: { type: 'String!' }, url: { type: 'URI!' }, avatarUrl: { type: 'URI!', args: { size: 'Int' } }, resourcePath: { type: 'URI!' } },
    possible: ['User'],
  },
  RepositoryOwner: {
    kind: 'INTERFACE',
    fields: { id: { type: 'ID!' }, login: { type: 'String!' }, url: { type: 'URI!' }, avatarUrl: { type: 'URI!', args: { size: 'Int' } }, repository: { type: 'Repository', args: { name: 'String!' } } },
    possible: ['User'],
  },
  IssueOrPullRequest: { kind: 'UNION', possible: ['Issue', 'PullRequest'] },
  SearchResultItem: { kind: 'UNION', possible: ['Issue', 'PullRequest', 'Repository', 'User'] },

  // ------------------------------------------------------------ objects
  PageInfo: {
    kind: 'OBJECT',
    fields: { hasNextPage: { type: 'Boolean!' }, hasPreviousPage: { type: 'Boolean!' }, startCursor: { type: 'String' }, endCursor: { type: 'String' } },
  },
  RateLimit: {
    kind: 'OBJECT',
    fields: { limit: { type: 'Int!' }, cost: { type: 'Int!' }, remaining: { type: 'Int!' }, used: { type: 'Int!' }, nodeCount: { type: 'Int!' }, resetAt: { type: 'DateTime!' } },
  },
  User: { kind: 'OBJECT', interfaces: ['Node', 'Actor', 'RepositoryOwner'], fields: ownerFields() },
  Organization: { kind: 'OBJECT', interfaces: ['Node'], fields: { id: { type: 'ID!' }, login: { type: 'String!' }, name: { type: 'String' } } },
  Label: {
    kind: 'OBJECT',
    interfaces: ['Node'],
    fields: {
      id: { type: 'ID!', resolve: (n: { label: Label }) => nodeId('Label', n.label.id) },
      name: { type: 'String!', resolve: (n: { label: Label }) => n.label.name },
      color: { type: 'String!', resolve: (n: { label: Label }) => n.label.color },
      description: { type: 'String', resolve: (n: { label: Label }) => n.label.description },
    },
  },
  IssueComment: {
    kind: 'OBJECT',
    interfaces: ['Node'],
    fields: {
      id: { type: 'ID!', resolve: (n: CommentNode) => nodeId('IssueComment', n.comment.id) },
      databaseId: { type: 'Int', resolve: (n: CommentNode) => n.comment.id },
      body: { type: 'String!', resolve: (n: CommentNode) => n.comment.body },
      bodyText: { type: 'String!', resolve: (n: CommentNode) => n.comment.body },
      author: { type: 'Actor', resolve: () => USER },
      authorAssociation: { type: 'String!', resolve: () => 'OWNER' },
      createdAt: { type: 'DateTime!', resolve: (n: CommentNode) => n.comment.created },
      updatedAt: { type: 'DateTime!', resolve: (n: CommentNode) => n.comment.updated },
      url: { type: 'URI!', resolve: (n: CommentNode) => `${repoUrl(n.repo)}/issues/${n.issue.number}#issuecomment-${n.comment.id}` },
      issue: { type: 'Issue!', resolve: (n: CommentNode) => issueNode(n.repo, n.issue) },
      viewerDidAuthor: { type: 'Boolean!', resolve: () => true },
    },
  },
  Commit: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID!', resolve: (n: CommitNode) => `C_${n.oid}` },
      oid: { type: 'GitObjectID!', resolve: (n: CommitNode) => n.oid },
      abbreviatedOid: { type: 'String!', resolve: (n: CommitNode) => n.oid.slice(0, 7) },
      message: { type: 'String!', resolve: (n: CommitNode) => shownMessage(commitInfo(n.oid).message) },
      messageHeadline: { type: 'String!', resolve: (n: CommitNode) => commitInfo(n.oid).message.split('\n')[0] },
      messageBody: { type: 'String!', resolve: (n: CommitNode) => shownMessage(commitInfo(n.oid).message).split('\n').slice(2).join('\n') },
      committedDate: { type: 'DateTime!', resolve: (n: CommitNode) => isoOf(parseIdent(commitInfo(n.oid).committer).seconds) },
      authoredDate: { type: 'DateTime!', resolve: (n: CommitNode) => isoOf(parseIdent(commitInfo(n.oid).author).seconds) },
      url: { type: 'URI!', resolve: (n: CommitNode) => `${repoUrl(n.repo)}/commit/${n.oid}` },
      history: {
        type: 'CommitConnection!',
        args: PAGING,
        resolve: (n: CommitNode, args) => connection(history(n.oid).map((oid) => ({ repo: n.repo, oid })), args),
      },
    },
  },
  Ref: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID!', resolve: (n: RefNode) => `REF_${Buffer.from(`${n.repo.id}:${n.ref}`, 'utf8').toString('base64url')}` },
      name: { type: 'String!', resolve: (n: RefNode) => n.ref.replace(/^refs\/(heads|tags)\//, '') },
      prefix: { type: 'String!', resolve: (n: RefNode) => (n.ref.startsWith('refs/tags/') ? 'refs/tags/' : 'refs/heads/') },
      target: { type: 'Commit', resolve: (n: RefNode) => commitNode(n.repo, peelToCommit(n.oid)) },
      repository: { type: 'Repository!', resolve: (n: RefNode) => n.repo },
    },
  },
  PullRequestChangedFile: {
    kind: 'OBJECT',
    fields: { path: { type: 'String!' }, additions: { type: 'Int!' }, deletions: { type: 'Int!' }, changeType: { type: 'PatchStatus!' } },
  },
  Issue: {
    kind: 'OBJECT',
    interfaces: ['Node'],
    fields: {
      ...commonIssueFields('issues'),
      stateReason: { type: 'IssueStateReason', resolve: (n: IssueNode) => (n.issue.stateReason === null ? null : n.issue.stateReason.toUpperCase()) },
    },
  },
  PullRequest: {
    kind: 'OBJECT',
    interfaces: ['Node'],
    fields: {
      ...commonIssueFields('pull'),
      merged: { type: 'Boolean!', resolve: (n: IssueNode) => n.issue.pull!.merged },
      mergedAt: { type: 'DateTime', resolve: (n: IssueNode) => n.issue.pull!.mergedAt },
      mergedBy: { type: 'Actor', resolve: (n: IssueNode) => (n.issue.pull!.merged ? USER : null) },
      isDraft: { type: 'Boolean!', resolve: (n: IssueNode) => n.issue.pull!.draft },
      headRefName: { type: 'String!', resolve: (n: IssueNode) => n.issue.pull!.head },
      baseRefName: { type: 'String!', resolve: (n: IssueNode) => n.issue.pull!.base },
      headRefOid: { type: 'GitObjectID!', resolve: (n: IssueNode) => pullTips(n.repo, n.issue).head },
      baseRefOid: { type: 'GitObjectID!', resolve: (n: IssueNode) => pullTips(n.repo, n.issue).base },
      headRepository: { type: 'Repository', resolve: (n: IssueNode) => n.repo },
      headRepositoryOwner: { type: 'RepositoryOwner', resolve: () => USER },
      baseRepository: { type: 'Repository', resolve: (n: IssueNode) => n.repo },
      isCrossRepository: { type: 'Boolean!', resolve: () => false },
      maintainerCanModify: { type: 'Boolean!', resolve: () => false },
      mergeable: {
        type: 'MergeableState!',
        resolve: (n: IssueNode) => (n.issue.state !== 'open' ? 'UNKNOWN' : isMergeable(n.repo, n.issue) ? 'MERGEABLE' : 'CONFLICTING'),
      },
      mergeStateStatus: { type: 'String!', resolve: (n: IssueNode) => (n.issue.state !== 'open' ? 'UNKNOWN' : isMergeable(n.repo, n.issue) ? 'CLEAN' : 'DIRTY') },
      mergeCommit: { type: 'Commit', resolve: (n: IssueNode) => commitNode(n.repo, n.issue.pull!.mergeSha) },
      headRef: {
        type: 'Ref',
        resolve: (n: IssueNode) => {
          const oid = branchTip(n.repo, n.issue.pull!.head);
          return oid === undefined ? null : { repo: n.repo, ref: `refs/heads/${n.issue.pull!.head}`, oid };
        },
      },
      baseRef: {
        type: 'Ref',
        resolve: (n: IssueNode) => {
          const oid = branchTip(n.repo, n.issue.pull!.base);
          return oid === undefined ? null : { repo: n.repo, ref: `refs/heads/${n.issue.pull!.base}`, oid };
        },
      },
      files: { type: 'PullRequestChangedFileConnection', args: PAGING, resolve: (n: IssueNode, args) => connection(filesOf(n), args) },
      changedFiles: { type: 'Int!', resolve: (n: IssueNode) => filesOf(n).length },
      additions: { type: 'Int!', resolve: (n: IssueNode) => filesOf(n).reduce((sum, file) => sum + file.additions, 0) },
      deletions: { type: 'Int!', resolve: (n: IssueNode) => filesOf(n).reduce((sum, file) => sum + file.deletions, 0) },
      commits: {
        type: 'CommitConnection!',
        args: PAGING,
        resolve: (n: IssueNode, args) => {
          const tips = pullTips(n.repo, n.issue);
          const own = history(tips.head).filter((oid) => !isAncestor(oid, tips.base)).reverse();
          return connection(own.map((oid) => ({ repo: n.repo, oid })), args);
        },
      },
      reviewDecision: { type: 'String', resolve: () => null },
    },
  },
  Repository: {
    kind: 'OBJECT',
    interfaces: ['Node'],
    fields: {
      id: { type: 'ID!', resolve: (r: Repo) => nodeId('Repository', r.id) },
      databaseId: { type: 'Int', resolve: (r: Repo) => r.id },
      name: { type: 'String!', resolve: (r: Repo) => r.name },
      nameWithOwner: { type: 'String!', resolve: (r: Repo) => `${viewer.login}/${r.name}` },
      owner: { type: 'RepositoryOwner!', resolve: () => USER },
      description: { type: 'String', resolve: (r: Repo) => r.description },
      url: { type: 'URI!', resolve: (r: Repo) => repoUrl(r) },
      sshUrl: { type: 'String!', resolve: (r: Repo) => `${repoUrl(r)}.git` },
      resourcePath: { type: 'URI!', resolve: (r: Repo) => `/${viewer.login}/${r.name}` },
      homepageUrl: { type: 'URI', resolve: () => null },
      isPrivate: { type: 'Boolean!', resolve: (r: Repo) => r.private },
      visibility: { type: 'RepositoryVisibility!', resolve: (r: Repo) => (r.private ? 'PRIVATE' : 'PUBLIC') },
      isFork: { type: 'Boolean!', resolve: () => false },
      isArchived: { type: 'Boolean!', resolve: () => false },
      isTemplate: { type: 'Boolean!', resolve: () => false },
      isEmpty: { type: 'Boolean!', resolve: (r: Repo) => r.refs.size === 0 },
      isInOrganization: { type: 'Boolean!', resolve: () => false },
      parent: { type: 'Repository', resolve: () => null },
      createdAt: { type: 'DateTime!', resolve: (r: Repo) => r.created },
      updatedAt: { type: 'DateTime!', resolve: (r: Repo) => r.updated },
      pushedAt: { type: 'DateTime', resolve: (r: Repo) => r.pushed },
      stargazerCount: { type: 'Int!', resolve: () => 0 },
      forkCount: { type: 'Int!', resolve: () => 0 },
      viewerPermission: { type: 'RepositoryPermission', resolve: () => 'ADMIN' },
      viewerCanAdminister: { type: 'Boolean!', resolve: () => true },
      hasIssuesEnabled: { type: 'Boolean!', resolve: () => true },
      hasWikiEnabled: { type: 'Boolean!', resolve: () => false },
      hasProjectsEnabled: { type: 'Boolean!', resolve: () => false },
      hasDiscussionsEnabled: { type: 'Boolean!', resolve: () => false },
      mergeCommitAllowed: { type: 'Boolean!', resolve: () => true },
      squashMergeAllowed: { type: 'Boolean!', resolve: () => true },
      rebaseMergeAllowed: { type: 'Boolean!', resolve: () => true },
      deleteBranchOnMerge: { type: 'Boolean!', resolve: () => false },
      defaultBranchRef: {
        type: 'Ref',
        resolve: (r: Repo) => {
          const oid = branchTip(r, r.defaultBranch);
          return oid === undefined ? null : { repo: r, ref: `refs/heads/${r.defaultBranch}`, oid };
        },
      },
      ref: {
        type: 'Ref',
        args: { qualifiedName: 'String!' },
        resolve: (r: Repo, args) => {
          const wanted = String(args.qualifiedName);
          for (const ref of [wanted, `refs/heads/${wanted}`, `refs/tags/${wanted}`]) {
            const oid = r.refs.get(ref);
            if (oid !== undefined) return { repo: r, ref, oid };
          }
          return null;
        },
      },
      refs: {
        type: 'RefConnection',
        args: { ...PAGING, refPrefix: 'String!', query: 'String' },
        resolve: (r: Repo, args) => {
          const prefix = String(args.refPrefix ?? 'refs/heads/');
          const found = [...r.refs].filter(([ref]) => ref.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1));
          return connection(found.map(([ref, oid]) => ({ repo: r, ref, oid })), args);
        },
      },
      issue: { type: 'Issue', args: { number: 'Int!' }, resolve: (r: Repo, args) => pick(r, args.number, false) },
      pullRequest: { type: 'PullRequest', args: { number: 'Int!' }, resolve: (r: Repo, args) => pick(r, args.number, true) },
      issueOrPullRequest: {
        type: 'IssueOrPullRequest',
        args: { number: 'Int!' },
        resolve: (r: Repo, args) => {
          const issue = r.issues.get(Number(args.number));
          return issue === undefined ? null : issueNode(r, issue);
        },
      },
      issues: {
        type: 'IssueConnection!',
        args: { ...PAGING, states: '[IssueState!]', orderBy: 'IssueOrder', labels: '[String!]', filterBy: 'IssueFilters' },
        resolve: (r: Repo, args) => connection(issuesOf(r, { ...args, states: args.states ?? args.filterBy?.states, labels: args.labels ?? args.filterBy?.labels }, false), args),
      },
      pullRequests: {
        type: 'PullRequestConnection!',
        args: { ...PAGING, states: '[PullRequestState!]', orderBy: 'IssueOrder', labels: '[String!]', headRefName: 'String', baseRefName: 'String' },
        resolve: (r: Repo, args) => connection(issuesOf(r, args, true), args),
      },
      labels: {
        type: 'LabelConnection',
        args: { ...PAGING, query: 'String' },
        resolve: (r: Repo, args) => connection([...r.labels.values()].map((label) => ({ __type: 'Label', repo: r, label })), args),
      },
      label: {
        type: 'Label',
        args: { name: 'String!' },
        resolve: (r: Repo, args) => {
          const label = r.labels.get(String(args.name).toLowerCase());
          return label === undefined ? null : { __type: 'Label', repo: r, label };
        },
      },
      assignableUsers: { type: 'UserConnection!', args: PAGING, resolve: (_r, args) => connection([USER], args) },
    },
  },

  // ------------------------------------------------------------ mutation payloads
  CreateIssuePayload: { kind: 'OBJECT', fields: { clientMutationId: { type: 'String' }, issue: { type: 'Issue' } } },
  UpdateIssuePayload: { kind: 'OBJECT', fields: { clientMutationId: { type: 'String' }, issue: { type: 'Issue' } } },
  CloseIssuePayload: { kind: 'OBJECT', fields: { clientMutationId: { type: 'String' }, issue: { type: 'Issue' } } },
  ReopenIssuePayload: { kind: 'OBJECT', fields: { clientMutationId: { type: 'String' }, issue: { type: 'Issue' } } },
  AddCommentPayload: {
    kind: 'OBJECT',
    fields: { clientMutationId: { type: 'String' }, commentEdge: { type: 'IssueCommentEdge' }, subject: { type: 'Node' } },
  },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: { clientMutationId: { type: 'String' }, pullRequest: { type: 'PullRequest' } } },
  UpdatePullRequestPayload: { kind: 'OBJECT', fields: { clientMutationId: { type: 'String' }, pullRequest: { type: 'PullRequest' } } },
  MergePullRequestPayload: { kind: 'OBJECT', fields: { clientMutationId: { type: 'String' }, pullRequest: { type: 'PullRequest' }, actor: { type: 'Actor' } } },
  ClosePullRequestPayload: { kind: 'OBJECT', fields: { clientMutationId: { type: 'String' }, pullRequest: { type: 'PullRequest' } } },
  ReopenPullRequestPayload: { kind: 'OBJECT', fields: { clientMutationId: { type: 'String' }, pullRequest: { type: 'PullRequest' } } },
  CreateRepositoryPayload: { kind: 'OBJECT', fields: { clientMutationId: { type: 'String' }, repository: { type: 'Repository' } } },

  // ------------------------------------------------------------ roots
  Query: {
    kind: 'OBJECT',
    fields: {
      viewer: { type: 'User!', resolve: () => USER },
      repository: {
        type: 'Repository',
        args: { owner: 'String!', name: 'String!', followRenames: 'Boolean' },
        resolve: (_s, args) => findRepo(String(args.owner), String(args.name)) ?? null,
      },
      node: { type: 'Node', args: { id: 'ID!' }, resolve: (_s, args) => nodeOf(args.id) },
      nodes: { type: '[Node]!', args: { ids: '[ID!]!' }, resolve: (_s, args) => (Array.isArray(args.ids) ? args.ids.map(nodeOf) : []) },
      user: { type: 'User', args: { login: 'String!' }, resolve: (_s, args) => (String(args.login).toLowerCase() === viewer.login.toLowerCase() ? USER : null) },
      repositoryOwner: {
        type: 'RepositoryOwner',
        args: { login: 'String!' },
        resolve: (_s, args) => (String(args.login).toLowerCase() === viewer.login.toLowerCase() ? USER : null),
      },
      organization: { type: 'Organization', args: { login: 'String!' }, resolve: () => null },
      rateLimit: { type: 'RateLimit', args: { dryRun: 'Boolean' }, resolve: () => ({ limit: 5000, cost: 1, remaining: 5000, used: 0, nodeCount: 0, resetAt: isoOf(0) }) },
      search: {
        type: 'SearchResultItemConnection!',
        args: { ...PAGING, query: 'String!', type: 'SearchType!' },
        resolve: (_s, args) => {
          const found = search(String(args.query ?? ''), String(args.type ?? 'ISSUE'));
          const page = connection(found, args);
          return { ...page, issueCount: found.length, repositoryCount: found.length, userCount: 0 };
        },
      },
    },
  },
  Mutation: {
    kind: 'OBJECT',
    fields: {
      createIssue: {
        type: 'CreateIssuePayload',
        args: { input: 'CreateIssueInput!' },
        resolve: (_s, { input }) => {
          const repo = needNode<Repo>(input?.repositoryId, ['Repository']);
          const labels = Array.isArray(input.labelIds) ? input.labelIds.map((id: unknown) => needNode<{ label: Label }>(id, ['Label']).label.name) : undefined;
          return { clientMutationId: input.clientMutationId ?? null, issue: issueNode(repo, openIssue(repo, { title: input.title, body: input.body, labels }, null)) };
        },
      },
      updateIssue: {
        type: 'UpdateIssuePayload',
        args: { input: 'UpdateIssueInput!' },
        resolve: (_s, { input }) => {
          const node = needNode<IssueNode>(input?.id, ['Issue']);
          editIssue(node.repo, node.issue, { title: input.title ?? undefined, body: input.body ?? undefined, state: typeof input.state === 'string' ? input.state.toLowerCase() : undefined });
          return { clientMutationId: input.clientMutationId ?? null, issue: node };
        },
      },
      closeIssue: {
        type: 'CloseIssuePayload',
        args: { input: 'CloseIssueInput!' },
        resolve: (_s, { input }) => {
          const node = needNode<IssueNode>(input?.issueId, ['Issue']);
          setIssueState(node.issue, 'closed', typeof input.stateReason === 'string' ? input.stateReason.toLowerCase() : undefined);
          return { clientMutationId: input.clientMutationId ?? null, issue: node };
        },
      },
      reopenIssue: {
        type: 'ReopenIssuePayload',
        args: { input: 'ReopenIssueInput!' },
        resolve: (_s, { input }) => {
          const node = needNode<IssueNode>(input?.issueId, ['Issue']);
          setIssueState(node.issue, 'open', 'reopened');
          return { clientMutationId: input.clientMutationId ?? null, issue: node };
        },
      },
      addComment: {
        type: 'AddCommentPayload',
        args: { input: 'AddCommentInput!' },
        resolve: (_s, { input }) => {
          const node = needNode<IssueNode>(input?.subjectId, ['Issue', 'PullRequest']);
          const comment = addComment(node.repo, node.issue, { body: input.body });
          const made: CommentNode = { __type: 'IssueComment', repo: node.repo, issue: node.issue, comment };
          return { clientMutationId: input.clientMutationId ?? null, commentEdge: { node: made, cursor: nodeId('IssueComment', comment.id) }, subject: node };
        },
      },
      createPullRequest: {
        type: 'CreatePullRequestPayload',
        args: { input: 'CreatePullRequestInput!' },
        resolve: (_s, { input }) => {
          const repo = needNode<Repo>(input?.repositoryId, ['Repository']);
          const issue = openPull(repo, { title: input.title, body: input.body, head: input.headRefName, base: input.baseRefName, draft: input.draft });
          return { clientMutationId: input.clientMutationId ?? null, pullRequest: issueNode(repo, issue) };
        },
      },
      updatePullRequest: {
        type: 'UpdatePullRequestPayload',
        args: { input: 'UpdatePullRequestInput!' },
        resolve: (_s, { input }) => {
          const node = needNode<IssueNode>(input?.pullRequestId, ['PullRequest']);
          editPull(node.repo, node.issue, { title: input.title ?? undefined, body: input.body ?? undefined, base: input.baseRefName ?? undefined, state: input.state === 'CLOSED' ? 'closed' : input.state === 'OPEN' ? 'open' : undefined });
          return { clientMutationId: input.clientMutationId ?? null, pullRequest: node };
        },
      },
      mergePullRequest: {
        type: 'MergePullRequestPayload',
        args: { input: 'MergePullRequestInput!' },
        resolve: (_s, { input }) => {
          const node = needNode<IssueNode>(input?.pullRequestId, ['PullRequest']);
          mergePull(node.repo, node.issue, {
            merge_method: typeof input.mergeMethod === 'string' ? input.mergeMethod.toLowerCase() : 'merge',
            commit_title: input.commitHeadline ?? undefined,
            commit_message: input.commitBody ?? undefined,
            sha: input.expectedHeadOid ?? undefined,
          });
          return { clientMutationId: input.clientMutationId ?? null, pullRequest: node, actor: USER };
        },
      },
      closePullRequest: {
        type: 'ClosePullRequestPayload',
        args: { input: 'ClosePullRequestInput!' },
        resolve: (_s, { input }) => {
          const node = needNode<IssueNode>(input?.pullRequestId, ['PullRequest']);
          editPull(node.repo, node.issue, { state: 'closed' });
          return { clientMutationId: input.clientMutationId ?? null, pullRequest: node };
        },
      },
      reopenPullRequest: {
        type: 'ReopenPullRequestPayload',
        args: { input: 'ReopenPullRequestInput!' },
        resolve: (_s, { input }) => {
          const node = needNode<IssueNode>(input?.pullRequestId, ['PullRequest']);
          editPull(node.repo, node.issue, { state: 'open' });
          return { clientMutationId: input.clientMutationId ?? null, pullRequest: node };
        },
      },
      createRepository: {
        type: 'CreateRepositoryPayload',
        args: { input: 'CreateRepositoryInput!' },
        resolve: (_s, { input }) => {
          const repo = createRepo({ name: input?.name, description: input?.description, private: input?.visibility !== 'PUBLIC' });
          return { clientMutationId: input.clientMutationId ?? null, repository: repo };
        },
      },
    },
  },
};

function pick(repo: Repo, number: unknown, pull: boolean): IssueNode | null {
  const issue = repo.issues.get(Number(number));
  if (issue === undefined || (issue.pull !== null) !== pull) return null;
  return issueNode(repo, issue);
}

/** A small subset of GitHub's search syntax: repo:, is:, state:, in-title words. */
function search(query: string, type: string): unknown[] {
  const words = query.split(/\s+/).filter((word) => word !== '');
  const terms: string[] = [];
  let repoFilter: string | null = null;
  let state: string | null = null;
  let kind: 'issue' | 'pr' | null = null;
  for (const word of words) {
    const lower = word.toLowerCase();
    if (lower.startsWith('repo:')) repoFilter = lower.slice(5);
    else if (lower === 'is:open' || lower === 'state:open') state = 'open';
    else if (lower === 'is:closed' || lower === 'state:closed') state = 'closed';
    else if (lower === 'is:issue' || lower === 'type:issue') kind = 'issue';
    else if (lower === 'is:pr' || lower === 'type:pr') kind = 'pr';
    else if (!/^[a-z-]+:/.test(lower)) terms.push(lower.replace(/^"|"$/g, ''));
  }
  const inRepo = (repo: Repo): boolean => repoFilter === null || repoFilter === `${viewer.login}/${repo.name}`.toLowerCase();
  if (type === 'REPOSITORY') {
    return listRepos()
      .filter((repo) => inRepo(repo) && terms.every((term) => repo.name.toLowerCase().includes(term)))
      .map((repo) => Object.assign(repo, { __type: 'Repository' }));
  }
  if (type === 'USER') return [];
  const out: IssueNode[] = [];
  for (const repo of listRepos()) {
    if (!inRepo(repo)) continue;
    for (const issue of repo.issues.values()) {
      if (state !== null && issue.state !== state) continue;
      if (kind === 'issue' && issue.pull !== null) continue;
      if (kind === 'pr' && issue.pull === null) continue;
      const text = `${issue.title}\n${issue.body}`.toLowerCase();
      if (terms.every((term) => text.includes(term))) out.push(issueNode(repo, issue));
    }
  }
  return out.reverse();
}

addConnection(schema, 'Issue');
addConnection(schema, 'PullRequest');
addConnection(schema, 'IssueComment');
addConnection(schema, 'Label');
addConnection(schema, 'Repository');
addConnection(schema, 'User');
addConnection(schema, 'Organization');
addConnection(schema, 'Ref');
addConnection(schema, 'Commit');
addConnection(schema, 'PullRequestChangedFile');
addConnection(schema, 'SearchResultItem', { issueCount: { type: 'Int!' }, repositoryCount: { type: 'Int!' }, userCount: { type: 'Int!' } });
