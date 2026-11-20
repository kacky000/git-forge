// The forge's front door: authenticate a request and hand it to the surface that owns the path.
//
//   /healthz                      liveness probe, no token
//   /api/v3/...                   REST v3            (src/rest/router.ts)
//   /api/graphql                  GraphQL v4         (src/graphql/endpoint.ts)
//   /mcp                          Model Context Protocol (src/mcp/endpoint.ts)
//   /{owner}/{repo}.git/...       git smart HTTP     (src/git/smart.ts)
//
// Everything else is a JSON 404. Every surface is a synchronous function from the request's
// parts to a reply, so one request can never see another's half-finished update; the HTTP
// layer underneath (src/http/server.ts) only frames requests and replies.

import { gunzipSync, inflateSync } from 'node:zlib';
import { adoptOwner, site, viewer } from './src/core/state.ts';
import { createHttpServer, type ForgeServer, type HttpReply, type HttpRequest } from './src/http/server.ts';
import { rest } from './src/rest/router.ts';
import { infoRefs, receivePack, uploadPack, type GitReply } from './src/git/smart.ts';
import { graphql } from './src/graphql/endpoint.ts';
import { mcp } from './src/mcp/endpoint.ts';

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const BEARER = `Bearer ${TOKEN}`;
const JSON_HEAD = 'Content-Type: application/json; charset=utf-8\r\nX-OAuth-Scopes: repo, read:org\r\nX-GitHub-Media-Type: github.v3; format=json\r\nX-GitHub-Request-Id: ';
const HEALTH: HttpReply = { status: 200, headers: 'Content-Type: application/json; charset=utf-8\r\n', body: Buffer.from('{"ok":true}', 'utf8') };

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
  if (TOKEN !== '' && header === BEARER) return true;
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

function jsonReply(status: number, body: Buffer | null, link?: string): HttpReply {
  const headers = link === undefined ? `${JSON_HEAD}${requestId()}\r\n` : `${JSON_HEAD}${requestId()}\r\nLink: ${link}\r\n`;
  return { status, headers, body };
}

function message(status: number, text: string, extra = ''): HttpReply {
  const body = Buffer.from(JSON.stringify({ message: text, documentation_url: 'https://docs.github.com/rest', status: String(status) }), 'utf8');
  return { status, headers: `${JSON_HEAD}${requestId()}\r\n${extra}`, body };
}

function gitReply(reply: GitReply): HttpReply {
  return {
    status: reply.status,
    headers: `Content-Type: ${reply.type}\r\nCache-Control: no-cache, max-age=0, must-revalidate\r\nX-GitHub-Request-Id: ${requestId()}\r\n`,
    body: reply.body,
  };
}

const GIT_PATH = /^\/([^/]+)\/([^/]+?)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** A request body with its content encoding undone; null when it does not decode. */
function decoded(request: HttpRequest): Buffer | null {
  const encoding = request.headers['content-encoding'];
  if (encoding === undefined || request.body.length === 0) return request.body;
  try {
    if (encoding === 'gzip' || encoding === 'x-gzip') return gunzipSync(request.body);
    if (encoding === 'deflate') return inflateSync(request.body);
  } catch {
    return null;
  }
  return request.body;
}

function respond(request: HttpRequest): HttpReply {
  const url = request.url;
  if (url === '/healthz' || url.startsWith('/healthz?')) return HEALTH;
  const host = request.headers.host;
  if (host !== undefined && host !== lastHost) {
    lastHost = host;
    site.origin = `http://${host}`;
  }
  const mark = url.indexOf('?');
  const path = mark < 0 ? url : url.slice(0, mark);
  const credentials = request.headers.authorization;
  if (!authorized(credentials)) {
    return message(401, credentials === undefined ? 'Requires authentication' : 'Bad credentials', GIT_PATH.test(path) ? 'WWW-Authenticate: Basic realm="git-forge"\r\n' : '');
  }
  const search = mark < 0 ? '' : url.slice(mark + 1);
  const method = request.method;
  const body = decoded(request);
  if (body === null) return message(400, 'The request body could not be decoded');

  if (path.startsWith('/api/v3')) {
    const tail = path.slice(7);
    if (tail === '' || tail.charCodeAt(0) === 47) {
      const reply = rest(method === 'HEAD' ? 'GET' : method, tail, search, body);
      return jsonReply(reply.status, reply.body, reply.link);
    }
  }
  if (path === '/api/graphql') {
    if (method !== 'POST') return message(404, 'Not Found');
    const reply = graphql(body);
    return jsonReply(reply.status, reply.body);
  }
  if (path === '/mcp' || path === '/mcp/') {
    const reply = mcp(method, body, request.headers);
    let headers = `X-GitHub-Request-Id: ${requestId()}\r\n`;
    for (const [name, value] of Object.entries(reply.headers)) headers += `${name}: ${value}\r\n`;
    if (reply.body !== null) headers += 'Content-Type: application/json; charset=utf-8\r\n';
    return { status: reply.status, headers, body: reply.body };
  }
  const git = GIT_PATH.exec(path);
  if (git !== null) {
    const owner = safeDecode(git[1]!);
    const name = safeDecode(git[2]!);
    if (!viewer.pinned) adoptOwner(owner, name);
    const what = git[3]!;
    if (what === 'info/refs' && (method === 'GET' || method === 'HEAD')) {
      return gitReply(infoRefs(owner, name, new URLSearchParams(search).get('service'), request.headers['git-protocol']));
    }
    if (what === 'git-upload-pack' && method === 'POST') return gitReply(uploadPack(owner, name, body));
    if (what === 'git-receive-pack' && method === 'POST') return gitReply(receivePack(owner, name, body));
  }
  return message(404, 'Not Found');
}

/** Build the server; the caller decides where it listens. */
export function createApp(): ForgeServer {
  return createHttpServer(respond);
}
