// A small HTTP/1.1 server on node:net.
//
// The forge answers every request synchronously from memory, so it needs very little of a
// general HTTP stack: read a request (Content-Length or chunked body), call one function, write
// the reply in a single socket write, keep the connection open. Doing exactly that, and no
// more, makes a request round trip markedly cheaper than going through node:http's streams.

import { createServer, type Server, type Socket } from 'node:net';

export interface HttpRequest {
  method: string;
  /** The request target as sent: path and query string. */
  url: string;
  /** Header names in lower case; a repeated header's values are joined with ", ". */
  headers: Record<string, string>;
  body: Buffer;
}

export interface HttpReply {
  status: number;
  /** Complete header lines, each ending in CRLF (Content-Length and Date are added here). */
  headers: string;
  body: Buffer | null;
}

export type HttpHandler = (request: HttpRequest) => HttpReply;

export type ForgeServer = Server & { closeAllConnections(): void };

const REASONS: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  304: 'Not Modified',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  411: 'Length Required',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Entity',
  431: 'Request Header Fields Too Large',
  500: 'Internal Server Error',
  501: 'Not Implemented',
};

const HEAD_END = Buffer.from('\r\n\r\n', 'latin1');
const EMPTY = Buffer.alloc(0);
const MAX_HEAD = 64 * 1024;
const MAX_BODY = 512 * 1024 * 1024;
/** Replies up to this size are copied next to their headers and sent as one buffer. */
const ONE_WRITE = 64 * 1024;

let dateLine = `Date: ${new Date().toUTCString()}\r\n`;
setInterval(() => {
  dateLine = `Date: ${new Date().toUTCString()}\r\n`;
}, 1000).unref();

/** How long after a request the event loop keeps polling without sleeping. */
const HOT_MS = 25;
let hotUntil = 0;
let hot = false;

function stayHot(): void {
  if (performance.now() < hotUntil) setImmediate(stayHot);
  else hot = false;
}

/**
 * A client that sends its requests one after another waits for each reply before it sends the
 * next, so the gap between two requests is short and the server would otherwise go to sleep in
 * the kernel and be woken again every time. While requests keep arriving, a pending immediate
 * keeps the loop turning with a zero poll timeout, so the next request is picked up at once;
 * HOT_MS after the last request the loop goes back to sleeping.
 */
function touch(): void {
  hotUntil = performance.now() + HOT_MS;
  if (!hot) {
    hot = true;
    setImmediate(stayHot);
  }
}

interface Head {
  method: string;
  url: string;
  headers: Record<string, string>;
  /** Where the body starts in the connection's buffer. */
  bodyStart: number;
  /** Content-Length, or -1 for a chunked body. */
  length: number;
  close: boolean;
}

/** Parse the request line and headers that end at `end`; null when they are not HTTP. */
function parseHead(buf: Buffer, start: number, end: number): Head | null {
  const text = buf.latin1Slice(start, end);
  let lineEnd = text.indexOf('\r\n');
  const first = lineEnd < 0 ? text : text.slice(0, lineEnd);
  const sp1 = first.indexOf(' ');
  const sp2 = first.lastIndexOf(' ');
  if (sp1 <= 0 || sp2 <= sp1 || !first.startsWith('HTTP/1.', sp2 + 1)) return null;
  const headers: Record<string, string> = {};
  while (lineEnd >= 0) {
    const from = lineEnd + 2;
    lineEnd = text.indexOf('\r\n', from);
    const line = lineEnd < 0 ? text.slice(from) : text.slice(from, lineEnd);
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).toLowerCase();
    const value = line.slice(colon + 1).trim();
    const before = headers[name];
    headers[name] = before === undefined ? value : `${before}, ${value}`;
  }
  let length = 0;
  const encoding = headers['transfer-encoding'];
  if (encoding !== undefined && /chunked/i.test(encoding)) length = -1;
  else if (headers['content-length'] !== undefined) {
    length = Number(headers['content-length']);
    if (!Number.isSafeInteger(length) || length < 0) return null;
  }
  const connection = headers.connection;
  const close = first.endsWith('HTTP/1.0') ? !(connection !== undefined && /keep-alive/i.test(connection)) : connection !== undefined && /close/i.test(connection);
  return { method: first.slice(0, sp1), url: first.slice(sp1 + 1, sp2), headers, bodyStart: end + 4, length, close };
}

/** Decode a chunked body starting at `start`; null while it is still incomplete. */
function readChunked(buf: Buffer, start: number): { body: Buffer; next: number } | null {
  const parts: Buffer[] = [];
  let pos = start;
  for (;;) {
    const lineEnd = buf.indexOf('\r\n', pos);
    if (lineEnd < 0) return null;
    const size = parseInt(buf.latin1Slice(pos, lineEnd).split(';')[0]!.trim(), 16);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('bad chunk size');
    pos = lineEnd + 2;
    if (size === 0) {
      // Trailer fields, if any, end with an empty line.
      for (;;) {
        const trailerEnd = buf.indexOf('\r\n', pos);
        if (trailerEnd < 0) return null;
        const blank = trailerEnd === pos;
        pos = trailerEnd + 2;
        if (blank) return { body: parts.length === 1 ? parts[0]! : Buffer.concat(parts), next: pos };
      }
    }
    if (buf.length < pos + size + 2) return null;
    parts.push(buf.subarray(pos, pos + size));
    pos += size + 2;
  }
}

function write(socket: Socket, reply: HttpReply, headOnly: boolean, close: boolean): void {
  const body = reply.body;
  const size = body === null ? 0 : body.length;
  let head = `HTTP/1.1 ${reply.status} ${REASONS[reply.status] ?? 'Status'}\r\n${reply.headers}`;
  if (reply.status !== 204 && reply.status !== 304) head += `Content-Length: ${size}\r\n`;
  head += close ? `${dateLine}Connection: close\r\n\r\n` : `${dateLine}\r\n`;
  if (body === null || size === 0 || headOnly) {
    socket.write(head, 'latin1');
  } else if (size <= ONE_WRITE) {
    const out = Buffer.allocUnsafe(head.length + size);
    out.latin1Write(head, 0);
    body.copy(out, head.length);
    socket.write(out);
  } else {
    socket.cork();
    socket.write(head, 'latin1');
    socket.write(body);
    socket.uncork();
  }
  if (close) socket.end();
}

function refuse(socket: Socket, status: number): void {
  const body = Buffer.from(JSON.stringify({ message: REASONS[status] ?? 'Bad Request' }), 'utf8');
  write(socket, { status, headers: 'Content-Type: application/json; charset=utf-8\r\n', body }, false, true);
}

function serve(socket: Socket, handler: HttpHandler): void {
  socket.setNoDelay(true);
  let chunks: Buffer[] = [];
  let held = 0;
  let head: Head | null = null;
  /** Bytes the buffer must hold before the pending request is complete (0: unknown). */
  let needed = 0;

  socket.on('data', (chunk: Buffer) => {
    chunks.push(chunk);
    held += chunk.length;
    if (held < needed) return;
    const buf = chunks.length === 1 ? chunk : Buffer.concat(chunks, held);
    let pos = 0;
    try {
      for (;;) {
        if (head === null) {
          const end = buf.indexOf(HEAD_END, pos);
          if (end < 0) {
            if (buf.length - pos > MAX_HEAD) {
              refuse(socket, 431);
              return;
            }
            break;
          }
          head = parseHead(buf, pos, end);
          if (head === null) {
            refuse(socket, 400);
            return;
          }
          if (head.length > MAX_BODY) {
            refuse(socket, 413);
            return;
          }
          const expect = head.headers.expect;
          if (expect !== undefined && /100-continue/i.test(expect)) socket.write('HTTP/1.1 100 Continue\r\n\r\n', 'latin1');
        }
        let body: Buffer;
        let next: number;
        if (head.length < 0) {
          const read = readChunked(buf, head.bodyStart);
          if (read === null) break;
          body = read.body;
          next = read.next;
        } else {
          next = head.bodyStart + head.length;
          if (buf.length < next) break;
          body = head.length === 0 ? EMPTY : buf.subarray(head.bodyStart, next);
        }
        const request = head;
        head = null;
        let reply: HttpReply;
        try {
          reply = handler({ method: request.method, url: request.url, headers: request.headers, body });
        } catch (err) {
          process.stderr.write(`[forge] request failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
          reply = { status: 500, headers: 'Content-Type: application/json; charset=utf-8\r\n', body: Buffer.from('{"message":"Server Error"}', 'utf8') };
        }
        write(socket, reply, request.method === 'HEAD', request.close);
        touch();
        pos = next;
        if (request.close) return;
        if (pos >= buf.length) break;
      }
    } catch {
      refuse(socket, 400);
      return;
    }
    if (pos >= buf.length) {
      chunks = [];
      held = 0;
      needed = 0;
      return;
    }
    // Keep what is left of an incomplete request for the next read.
    const rest = pos === 0 ? buf : buf.subarray(pos);
    chunks = [rest];
    held = rest.length;
    if (head !== null) {
      head.bodyStart -= pos;
      needed = head.length < 0 ? 0 : head.bodyStart + head.length;
    } else needed = 0;
  });
  socket.on('error', () => socket.destroy());
}

/** Build the server; the caller decides where it listens. */
export function createHttpServer(handler: HttpHandler): ForgeServer {
  const open = new Set<Socket>();
  const server = createServer({ allowHalfOpen: false, noDelay: true, keepAlive: false }, (socket) => {
    open.add(socket);
    socket.on('close', () => open.delete(socket));
    serve(socket, handler);
  }) as ForgeServer;
  server.closeAllConnections = (): void => {
    for (const socket of open) socket.destroy();
    open.clear();
  };
  return server;
}
