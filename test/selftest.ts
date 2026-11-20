// An end-to-end self-test: start the forge on an ephemeral port and drive every surface over
// HTTP the way a client would. Run it with `node --experimental-strip-types test/selftest.ts`.

import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';

process.env.MAKEFUN_SHOP_TOKEN = 'selftest-token';
const { createApp } = await import('../app.ts');

const server = createApp();
await new Promise<void>((ready) => server.listen(0, '127.0.0.1', () => ready()));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const auth = { authorization: 'Bearer selftest-token' };
const OWNER = 'adaiversen';

let checks = 0;
function expect(condition: unknown, what: string): void {
  checks += 1;
  if (condition !== true) {
    process.stderr.write(`FAILED: ${what}\n`);
    process.exitCode = 1;
  }
}

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = auth): Promise<{ status: number; json: any; headers: Headers }> {
  const reply = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await reply.text();
  let json: unknown = null;
  try {
    json = text === '' ? null : JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: reply.status, json, headers: reply.headers };
}

const pktLine = (text: string): Buffer => Buffer.from((text.length + 4).toString(16).padStart(4, '0') + text, 'utf8');

function gitHash(type: string, data: Buffer): string {
  return createHash('sha1').update(`${type} ${data.length}\0`).update(data).digest('hex');
}

/** A pack of whole objects, as a git client would push it. */
function packOf(objects: { type: string; data: Buffer }[]): Buffer {
  const codes: Record<string, number> = { commit: 1, tree: 2, blob: 3 };
  const header = Buffer.alloc(12);
  header.write('PACK');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts = [header];
  for (const object of objects) {
    let size = object.data.length;
    const head: number[] = [];
    let first = (codes[object.type]! << 4) | (size & 15);
    size >>= 4;
    while (size > 0) {
      head.push(first | 0x80);
      first = size & 0x7f;
      size >>= 7;
    }
    head.push(first);
    parts.push(Buffer.from(head), deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

async function git(path: string, body?: Buffer, v2 = true): Promise<{ status: number; type: string; bytes: Buffer }> {
  const headers: Record<string, string> = { ...auth };
  if (v2) headers['git-protocol'] = 'version=2';
  const reply = await fetch(`${base}/${OWNER}/${path}`, { method: body === undefined ? 'GET' : 'POST', headers, body });
  return { status: reply.status, type: reply.headers.get('content-type') ?? '', bytes: Buffer.from(await reply.arrayBuffer()) };
}

// ---------------------------------------------------------------- protocol
expect((await call('GET', '/healthz', undefined, {})).status === 200, 'healthz answers without a token');
expect((await call('GET', '/api/v3/user', undefined, {})).status === 401, 'a request without a token is 401');
expect((await call('GET', '/api/v3/nope')).status === 404, 'an unknown route is 404');
expect((await call('POST', '/api/v3/user/repos', '{"name":')).status === 400, 'malformed JSON is 400');
const root = await call('GET', '/api/v3/');
expect(root.status === 200 && root.headers.get('x-oauth-scopes') !== null && root.headers.get('x-github-request-id') !== null, 'the API root carries its headers');

// ---------------------------------------------------------------- repositories and contents
const made = await call('POST', '/api/v3/user/repos', { name: 'demo', private: true, description: 'first' });
expect(made.status === 201 && made.json.name === 'demo' && made.json.private === true, 'a repository is created');
expect((await call('POST', '/api/v3/user/repos', { name: 'demo' })).status === 422, 'a duplicate name is 422');
const repo = `/api/v3/repos/${OWNER}/demo`;
expect((await call('GET', repo)).json.description === 'first', 'the repository reads back');
expect((await call('GET', '/api/v3/repos/someone-else/demo')).status === 404, 'another owner is 404');
const put = await call('PUT', `${repo}/contents/docs/a.txt`, { message: 'add a', content: Buffer.from('one\ntwo\n').toString('base64') });
expect(put.status === 201 && /^[0-9a-f]{40}$/.test(put.json.commit.sha), 'a file is created with a commit');
const file = await call('GET', `${repo}/contents/docs/a.txt`);
expect(Buffer.from(file.json.content, 'base64').toString() === 'one\ntwo\n' && file.json.sha === put.json.content.sha, 'the file reads back');
const listing = await call('GET', `${repo}/contents/docs`);
expect(Array.isArray(listing.json) && listing.json[0].name === 'a.txt', 'a directory lists its entries');
const update = await call('PUT', `${repo}/contents/docs/a.txt`, { message: 'edit a', content: Buffer.from('one\n2\n').toString('base64'), sha: file.json.sha });
expect(update.status === 200, 'an update with the current sha is 200');
expect((await call('PUT', `${repo}/contents/docs/a.txt`, { message: 'stale', content: 'eA==', sha: file.json.sha })).status === 409, 'a stale sha is 409');

// ---------------------------------------------------------------- issues
expect((await call('POST', `${repo}/issues`, { title: 'x', labels: ['bug'] })).status === 422, 'an unknown label is 422');
expect((await call('POST', `${repo}/labels`, { name: 'bug', color: 'ff0000' })).status === 201, 'a label is created');
const issue = await call('POST', `${repo}/issues`, { title: 'First', body: 'text', labels: ['bug'] });
expect(issue.status === 201 && issue.json.number === 1 && issue.json.labels[0].name === 'bug', 'an issue is created');
expect((await call('PATCH', `${repo}/issues/1`, { state: 'closed' })).json.state === 'closed', 'an issue closes');
expect((await call('GET', `${repo}/issues`)).json.length === 0, 'the default list is open issues only');
expect((await call('POST', `${repo}/issues/1/comments`, { body: 'hi' })).status === 201, 'a comment is created');

// ---------------------------------------------------------------- pull requests
expect((await call('POST', `${repo}/git/refs`, { ref: 'refs/heads/topic', sha: update.json.commit.sha })).status === 201, 'a branch is created');
await call('PUT', `${repo}/contents/b.txt`, { message: 'add b', content: Buffer.from('b\n').toString('base64'), branch: 'topic' });
const pull = await call('POST', `${repo}/pulls`, { title: 'Topic', body: 'why', head: 'topic', base: 'main' });
expect(pull.status === 201 && pull.json.state === 'open' && pull.json.head.ref === 'topic', 'a pull request opens');
const files = await call('GET', `${repo}/pulls/${pull.json.number}/files`);
expect(files.json.length === 1 && files.json[0].filename === 'b.txt' && files.json[0].additions === 1, 'the pull request lists its file');
const merge = await call('PUT', `${repo}/pulls/${pull.json.number}/merge`, { merge_method: 'squash' });
expect(merge.status === 200 && merge.json.merged === true, 'the pull request merges');
expect((await call('GET', `${repo}/contents/b.txt`)).status === 200, 'the merged file is on the default branch');
expect((await call('PUT', `${repo}/pulls/${pull.json.number}/merge`, {})).status === 405, 'a second merge is 405');
expect((await call('PUT', `${repo}/pulls/999/merge`, {})).status === 404, 'merging an unknown pull request is 404');

// ---------------------------------------------------------------- git
await call('POST', '/api/v3/user/repos', { name: 'pushed' });
const blob = Buffer.from('pushed over git\n');
const tree = Buffer.concat([Buffer.from('100644 f.txt\0'), Buffer.from(gitHash('blob', blob), 'hex')]);
const commit = Buffer.from(`tree ${gitHash('tree', tree)}\nauthor T <t@example.invalid> 1700000000 +0000\ncommitter T <t@example.invalid> 1700000000 +0000\n\nroot\n`);
const tip = gitHash('commit', commit);
const push = await git('pushed.git/git-receive-pack', Buffer.concat([
  pktLine(`${'0'.repeat(40)} ${tip} refs/heads/main\0report-status side-band-64k\n`),
  Buffer.from('0000'),
  packOf([{ type: 'blob', data: blob }, { type: 'tree', data: tree }, { type: 'commit', data: commit }]),
]), false);
expect(push.status === 200 && push.bytes.includes('unpack ok') && push.bytes.includes('ok refs/heads/main'), 'a push is accepted');
const advert = await git('pushed.git/info/refs?service=git-upload-pack');
expect(advert.bytes.includes('version 2') && advert.type.includes('upload-pack-advertisement'), 'upload-pack advertises protocol v2');
const refs = await git('pushed.git/git-upload-pack', Buffer.concat([pktLine('command=ls-refs\n'), Buffer.from('0001'), pktLine('symrefs\n'), Buffer.from('0000')]));
expect(refs.bytes.includes(`${tip} HEAD symref-target:refs/heads/main`), 'ls-refs names HEAD');
const fetched = await git('pushed.git/git-upload-pack', Buffer.concat([pktLine('command=fetch\n'), Buffer.from('0001'), pktLine(`want ${tip}\n`), pktLine('done\n'), Buffer.from('0000')]));
expect(fetched.bytes.includes('packfile\n') && fetched.bytes.includes('PACK'), 'fetch answers a packfile');
expect((await git('missing.git/info/refs?service=git-upload-pack')).status === 404, 'a missing repository is 404');
expect((await call('GET', `/api/v3/repos/${OWNER}/pushed/contents/f.txt`)).json.size === blob.length, 'REST reads what git pushed');

// ---------------------------------------------------------------- GraphQL
const gql = async (query: string, variables: unknown = {}) => (await call('POST', '/api/graphql', { query, variables })).json;
const viewer = await gql('{ viewer { login } repository(owner: "adaiversen", name: "demo") { id issues(first: 5, states: [CLOSED]) { nodes { number state } } } }');
expect(viewer.data.viewer.login === OWNER && viewer.data.repository.issues.nodes[0].state === 'CLOSED', 'GraphQL reads the store');
const created = await gql('mutation($input: CreateIssueInput!) { createIssue(input: $input) { issue { number } } }', { input: { repositoryId: viewer.data.repository.id, title: 'Over GraphQL' } });
expect(created.data.createIssue.issue.number === 3, 'GraphQL creates an issue in the shared number sequence');
expect((await gql('{ viewer { nope } }')).errors[0].message.includes('nope'), 'an unknown field is reported');
expect((await gql('{ __type(name: "Issue") { fields { name type { kind name ofType { name } } } } }')).data.__type.fields.length > 10, 'introspection describes Issue');
expect((await gql('{ __schema { types { name kind fields { name args { name type { name } } type { name } } inputFields { name type { name } } enumValues { name } possibleTypes { name } interfaces { name } } } }')).errors === undefined, 'the whole schema introspects');

// ---------------------------------------------------------------- MCP
const rpc = async (method: string, params: unknown = {}) => (await call('POST', '/mcp', { jsonrpc: '2.0', id: 7, method, params })).json;
expect((await rpc('server/discover')).result.supportedVersions.includes('2026-07-28'), 'server/discover lists its revisions');
expect((await rpc('tools/list')).result.tools.length >= 6, 'tools/list offers the tools');
const viaTool = await rpc('tools/call', { name: 'create_issue', arguments: { owner: OWNER, repo: 'demo', title: 'Over MCP' } });
expect(viaTool.result.isError === false && viaTool.result.structuredContent.number === 4, 'a tool creates an issue');
expect((await rpc('tools/call', { name: 'create_issue', arguments: {} })).result.isError === true, 'missing arguments are a tool error');
expect((await rpc('tools/call', { name: 'no_such_tool' })).error.code === -32602, 'an unknown tool is -32602');
expect((await call('POST', '/mcp', '{"jsonrpc":')).status === 400, 'a body that is not JSON is 400');

server.close();
server.closeAllConnections();
process.stdout.write(`${process.exitCode === 1 ? 'selftest FAILED' : 'selftest passed'} (${checks} checks)\n`);
