// The forge's HTTP front door: one node:http server that authenticates a request, reads its
// body and hands it to the surface that owns the path:
//
//   /healthz                      liveness probe, no token
//   /api/v3/...                   REST v3            (src/rest/router.ts)
//   /api/graphql                  GraphQL v4         (src/graphql/endpoint.ts)
//   /mcp                          Model Context Protocol (src/mcp/endpoint.ts)
//   /{owner}/{repo}.git/...       git smart HTTP     (src/git/smart.ts)
//
// Everything else is a JSON 404. Handlers are synchronous functions from request parts to a
// reply, so a request can never leave the store half-updated.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { gunzipSync, inflateSync } from 'node:zlib';
import { adoptOwner, site } from './src/core/state.ts';
import { rest } from './src/rest/router.ts';
import { infoRefs, receivePack, uploadPack, type GitReply } from './src/git/smart.ts';
import { graphql } from './src/graphql/endpoint.ts';
import { mcp } from './src/mcp/endpoint.ts';

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY = 256 * 1024 * 1024;

let served = 0;
let lastHost = '';

/** A fresh request id: unique per reply, with no clock or randomness behind it. */
function requestId(): string {
  served += 1;
  const hex = served.toString(16).toUpperCase().padStart(12, '0');
  return `F06E:${hex.slice(0, 4)}:${hex.slice(4, 8)}:${hex.slice(8)}`;
}

/** Whether the request carries the trial's token (as Bearer, `token`, or a Basic password). */
function authorized(header: string | undefined): boolean {
  if (header === undefined) return false;
  const space = header.indexOf(' ');
  if (space < 0) return false;
  const scheme = header.slice(0, space).toLowerCase();
  let secret = header.slice(space + 1).trim();
  if (scheme === 'basic') {
    const pair = Buffer.from(secret, 'base64').toString('utf8');
    const colon = pair.indexOf(':');
    const user = colon < 0 ? pair : pair.slice(0, colon);
    secret = colon < 0 ? '' : pair.slice(colon + 1);
    if (secret === '' || secret === 'x-oauth-basic') secret = user;
  } else if (scheme !== 'bearer' && scheme !== 'token') return false;
  if (secret === '') return false;
  return TOKEN === '' || secret === TOKEN;
}

function sendJson(res: ServerResponse, status: number, body: Buffer | null, link?: string): void {
  if (body === null) {
    res.writeHead(status, ['X-GitHub-Request-Id', requestId(), 'X-OAuth-Scopes', 'repo, read:org']);
    res.end();
    return;
  }
  const headers = [
    'Content-Type', JSON_TYPE,
    'Content-Length', String(body.length),
    'X-GitHub-Request-Id', requestId(),
    'X-OAuth-Scopes', 'repo, read:org',
    'X-GitHub-Media-Type', 'github.v3; format=json',
  ];
  if (link !== undefined) headers.push('Link', link);
  res.writeHead(status, headers);
  res.end(body);
}

function sendMessage(res: ServerResponse, status: number, message: string, extra?: string[]): void {
  const body = Buffer.from(JSON.stringify({ message, documentation_url: 'https://docs.github.com/rest', status: String(status) }), 'utf8');
  const headers = ['Content-Type', JSON_TYPE, 'Content-Length', String(body.length), 'X-GitHub-Request-Id', requestId()];
  if (extra !== undefined) headers.push(...extra);
  res.writeHead(status, headers);
  res.end(body);
}

function sendGit(res: ServerResponse, reply: GitReply): void {
  res.writeHead(reply.status, [
    'Content-Type', reply.type,
    'Content-Length', String(reply.body.length),
    'Cache-Control', 'no-cache, max-age=0, must-revalidate',
    'X-GitHub-Request-Id', requestId(),
  ]);
  res.end(reply.body);
}

/** Collect a request body, undoing a gzip or deflate content encoding. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      let body = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks);
      const encoding = req.headers['content-encoding'];
      try {
        if (encoding === 'gzip' || encoding === 'x-gzip') body = gunzipSync(body);
        else if (encoding === 'deflate') body = inflateSync(body);
      } catch (err) {
        reject(err);
        return;
      }
      resolve(body);
    });
  });
}

const GIT_PATH = /^\/([^/]+)\/([^/]+?)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

function dispatch(req: IncomingMessage, res: ServerResponse, body: Buffer): void {
  const url = req.url ?? '/';
  const mark = url.indexOf('?');
  const path = mark < 0 ? url : url.slice(0, mark);
  const search = mark < 0 ? '' : url.slice(mark + 1);
  const method = req.method ?? 'GET';

  if (path.startsWith('/api/v3')) {
    const tail = path.slice(7);
    if (tail === '' || tail.charCodeAt(0) === 47) {
      const reply = rest(method, tail, search, body);
      sendJson(res, reply.status, reply.body, reply.link);
      return;
    }
  }
  if (path === '/api/graphql') {
    if (method !== 'POST') {
      sendMessage(res, 404, 'Not Found');
      return;
    }
    const reply = graphql(body);
    sendJson(res, reply.status, reply.body);
    return;
  }
  if (path === '/mcp' || path === '/mcp/') {
    const reply = mcp(method, body, req.headers);
    const headers = ['X-GitHub-Request-Id', requestId()];
    for (const [name, value] of Object.entries(reply.headers)) headers.push(name, value);
    if (reply.body !== null) headers.push('Content-Type', JSON_TYPE, 'Content-Length', String(reply.body.length));
    res.writeHead(reply.status, headers);
    res.end(reply.body ?? undefined);
    return;
  }
  const git = GIT_PATH.exec(path);
  if (git !== null) {
    const owner = decodeURIComponent(git[1]!);
    const name = decodeURIComponent(git[2]!);
    adoptOwner(owner, name);
    const what = git[3]!;
    if (what === 'info/refs' && (method === 'GET' || method === 'HEAD')) {
      const proto = req.headers['git-protocol'];
      sendGit(res, infoRefs(owner, name, new URLSearchParams(search).get('service'), typeof proto === 'string' ? proto : undefined));
      return;
    }
    if (what === 'git-upload-pack' && method === 'POST') {
      sendGit(res, uploadPack(owner, name, body));
      return;
    }
    if (what === 'git-receive-pack' && method === 'POST') {
      sendGit(res, receivePack(owner, name, body));
      return;
    }
  }
  sendMessage(res, 404, 'Not Found');
}

function handle(req: IncomingMessage, res: ServerResponse): void {
  const url = req.url ?? '/';
  if (url === '/healthz' || url.startsWith('/healthz?')) {
    const body = Buffer.from('{"ok":true}', 'utf8');
    res.writeHead(200, ['Content-Type', JSON_TYPE, 'Content-Length', String(body.length)]);
    res.end(body);
    return;
  }
  const host = req.headers.host;
  if (host !== undefined && host !== lastHost) {
    lastHost = host;
    site.origin = `http://${host}`;
  }
  if (!authorized(req.headers.authorization)) {
    // Drain whatever the client is still sending so the connection stays usable.
    req.resume();
    const isGit = GIT_PATH.test(url.split('?')[0] ?? '');
    sendMessage(res, 401, req.headers.authorization === undefined ? 'Requires authentication' : 'Bad credentials', isGit ? ['WWW-Authenticate', 'Basic realm="git-forge"'] : undefined);
    return;
  }
  const method = req.method ?? 'GET';
  if (method === 'GET' || method === 'HEAD') {
    dispatch(req, res, EMPTY);
    return;
  }
  readBody(req).then(
    (body) => {
      try {
        dispatch(req, res, body);
      } catch (err) {
        crash(res, err);
      }
    },
    () => {
      if (!res.headersSent) sendMessage(res, 400, 'Problems reading the request body');
    },
  );
}

const EMPTY = Buffer.alloc(0);

function crash(res: ServerResponse, err: unknown): void {
  process.stderr.write(`[forge] request failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  if (!res.headersSent) sendMessage(res, 500, 'Server Error');
  else res.destroy();
}

/** Build the server; the caller decides where it listens. */
export function createApp(): Server {
  const server = createServer((req, res) => {
    try {
      handle(req, res);
    } catch (err) {
      crash(res, err);
    }
  });
  // The suite keeps connections open across long pauses; never be the side that hangs up first.
  server.keepAliveTimeout = 600_000;
  server.headersTimeout = 610_000;
  server.requestTimeout = 0;
  server.timeout = 0;
  return server;
}
