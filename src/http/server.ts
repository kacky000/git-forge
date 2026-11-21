// A small HTTP/1.1 server on node:net.
//
// The forge answers every request synchronously from memory, so it needs very little of a
// general HTTP stack: read a request (Content-Length or chunked body), call one function, write
// the reply in a single socket write, keep the connection open. Doing exactly that, and no
// more, makes a request round trip markedly cheaper than going through node:http's streams.

import { readSync } from 'node:fs';
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
  /**
   * True when handling the request changed nothing and the reply depends only on the request's
   * bytes and the forge's state: such a reply may answer the same bytes again until a request
   * without this mark arrives.
   */
  pure?: boolean;
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

/** Requests longer than this are never looked up in, or added to, the reply cache. */
const CACHE_REQUEST_MAX = 4096;
/** Replies longer than this are never kept in the reply cache. */
const CACHE_REPLY_MAX = 1024 * 1024;
const CACHE_ENTRIES_MAX = 512;

/**
 * Whole replies, as written to the socket, by the exact bytes of the request they answered.
 * Only replies the handler marked `pure` are kept, and the first request that is not pure
 * empties the cache, so a hit is always what the handler would have answered. The Date header
 * is part of a cached reply, so the cache also empties when the second changes.
 */
const replyCache = new Map<string, Buffer>();

let dateLine = `Date: ${new Date().toUTCString()}\r\n`;
setInterval(() => {
  dateLine = `Date: ${new Date().toUTCString()}\r\n`;
  if (replyCache.size > 0) replyCache.clear();
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
  const lineEnd = text.indexOf('\r\n');
  const first = lineEnd < 0 ? text : text.slice(0, lineEnd);
  const sp1 = first.indexOf(' ');
  const sp2 = first.lastIndexOf(' ');
  if (sp1 <= 0 || sp2 <= sp1 || !first.startsWith('HTTP/1.', sp2 + 1)) return null;
  // One client sends the same header lines with every request, so a block seen before is
  // not parsed again. The parsed headers are shared between requests and never modified.
  const block = lineEnd < 0 ? '' : text.slice(lineEnd + 2);
  let fields = fieldCache.get(block);
  if (fields === undefined) {
    const parsed = parseFields(block);
    if (parsed === null) return null;
    if (fieldCache.size >= FIELD_CACHE_MAX) fieldCache.clear();
    fieldCache.set(block, parsed);
    fields = parsed;
  }
  const close = first.endsWith('HTTP/1.0') ? !fields.keepAlive : fields.close;
  return { method: first.slice(0, sp1), url: first.slice(sp1 + 1, sp2), headers: fields.headers, bodyStart: end + 4, length: fields.length, close };
}

interface Fields {
  headers: Record<string, string>;
  /** Content-Length, or -1 for a chunked body. */
  length: number;
  /** The Connection header asks to close. */
  close: boolean;
  /** The Connection header asks to keep the connection (what HTTP/1.0 needs). */
  keepAlive: boolean;
}

const FIELD_CACHE_MAX = 2048;
const fieldCache = new Map<string, Fields>();

/** Parse the header lines of a request (everything after the request line); null when malformed. */
function parseFields(block: string): Fields | null {
  const headers: Record<string, string> = {};
  let from = 0;
  while (from < block.length) {
    let lineEnd = block.indexOf('\r\n', from);
    if (lineEnd < 0) lineEnd = block.length;
    const line = block.slice(from, lineEnd);
    from = lineEnd + 2;
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
  return {
    headers,
    length,
    close: connection !== undefined && /close/i.test(connection),
    keepAlive: connection !== undefined && /keep-alive/i.test(connection),
  };
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

/**
 * Send a reply. With `keep`, the reply is always built as one buffer and returned, so the
 * caller can send the same bytes again; otherwise a large body is written after its headers
 * without being copied and nothing is returned.
 */
function write(socket: Socket, reply: HttpReply, headOnly: boolean, close: boolean, keep: boolean): Buffer | null {
  const body = reply.body;
  const size = body === null ? 0 : body.length;
  let head = `HTTP/1.1 ${reply.status} ${REASONS[reply.status] ?? 'Status'}\r\n${reply.headers}`;
  if (reply.status !== 204 && reply.status !== 304) head += `Content-Length: ${size}\r\n`;
  head += close ? `${dateLine}Connection: close\r\n\r\n` : `${dateLine}\r\n`;
  let out: Buffer | null = null;
  if (body === null || size === 0 || headOnly) {
    if (keep) {
      out = Buffer.from(head, 'latin1');
      socket.write(out);
    } else socket.write(head, 'latin1');
  } else if (size <= ONE_WRITE || keep) {
    out = Buffer.allocUnsafe(head.length + size);
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
  return out;
}

function refuse(socket: Socket, status: number): void {
  const body = Buffer.from(JSON.stringify({ message: REASONS[status] ?? 'Bad Request' }), 'utf8');
  write(socket, { status, headers: 'Content-Type: application/json; charset=utf-8\r\n', body }, false, true, false);
}

function serve(socket: Socket, handler: HttpHandler): void {
  socket.setNoDelay(true);
  let chunks: Buffer[] = [];
  let held = 0;
  let head: Head | null = null;
  /** Bytes the buffer must hold before the pending request is complete (0: unknown). */
  let needed = 0;

  /** Take the next bytes of the connection: answer every request they complete. */
  const feed = (chunk: Buffer): void => {
    // A read that is, byte for byte, a request already answered purely gets the same reply.
    let key = '';
    if (held === 0 && chunk.length <= CACHE_REQUEST_MAX) {
      key = chunk.latin1Slice(0, chunk.length);
      const hit = replyCache.get(key);
      if (hit !== undefined) {
        socket.write(hit);
        touch();
        return;
      }
    }
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
        if (reply.pure === true) {
          // Cacheable only when this read held exactly this one request and nothing else.
          const keep = key !== '' && pos === 0 && next === buf.length && !request.close && request.headers.expect === undefined;
          const sent = write(socket, reply, request.method === 'HEAD', request.close, keep);
          if (keep && sent !== null && sent.length <= CACHE_REPLY_MAX) {
            if (replyCache.size >= CACHE_ENTRIES_MAX) replyCache.clear();
            replyCache.set(key, sent);
          }
        } else {
          if (replyCache.size > 0) replyCache.clear();
          write(socket, reply, request.method === 'HEAD', request.close, false);
        }
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
  };
  socket.on('data', (chunk: Buffer) => {
    feed(chunk);
    if (directReads) readAhead(socket, feed);
  });
  socket.on('error', () => socket.destroy());
}

/** How long a run of direct reads waits for the next request before giving up. */
const DIRECT_WAIT_MS = 4;
/** The longest one run of direct reads keeps the event loop from turning. */
const DIRECT_SLICE_MS = 12;
/** The talking connections must have been the same ones for this long before they are read directly. */
const DIRECT_SETTLE_MS = 50;
/** The most connections one run of direct reads watches. */
const TALKERS_MAX = 3;
/**
 * Direct reads need a connection's file descriptor, which only POSIX systems expose; they are
 * tried on Linux alone (FORGE_DIRECT_READS=0 turns them off) and stop for good at the first
 * surprise.
 */
let directReads = process.platform === 'linux' && process.env.FORGE_DIRECT_READS !== '0';
const directBuffer = Buffer.allocUnsafe(64 * 1024);

interface Talker {
  socket: Socket;
  feed: (chunk: Buffer) => void;
}

/** The connections that sent the latest requests, and when that set last changed. */
let talkers: Talker[] = [];
let talkersSince = 0;

/** The descriptor of an open connection; -1 once it is closed or where there is none to see. */
function descriptorOf(socket: Socket): number {
  if (socket.destroyed || socket.readableEnded || !socket.writable) return -1;
  const handle = (socket as unknown as { _handle?: { fd?: unknown } | null })._handle;
  if (handle === undefined || handle === null) return -1;
  const fd = handle.fd;
  return typeof fd === 'number' && fd >= 0 ? fd : -1;
}

function dropTalker(gone: Talker): void {
  talkers = talkers.filter((other) => other !== gone);
  talkersSince = performance.now();
}

/**
 * When one client talks to the forge alone, sending each request as soon as it has the reply
 * to the one before, the next request is on its way the moment a reply is written. (Such a
 * client may still alternate between two or three kept-alive connections.) Instead of going
 * back to the event loop (a poll, a read, the stream's own bookkeeping), read those
 * connections' descriptors directly for a short while and hand what arrives to the same
 * `feed`. The descriptors are non-blocking, so an empty read fails at once with EAGAIN and is
 * tried again; the run ends when nothing arrives for DIRECT_WAIT_MS or after DIRECT_SLICE_MS,
 * so timers and other connections are never kept waiting longer than that. Bytes not taken
 * here are delivered by the event loop as usual, in order, to the same `feed`. With more
 * connections talking than TALKERS_MAX (many clients at once) nothing is read directly.
 * A descriptor is looked up afresh before every read and only on a connection that is still
 * open, so a number the system has given to another connection is never read by mistake.
 */
function readAhead(socket: Socket, feed: (chunk: Buffer) => void): void {
  const started = performance.now();
  let known = false;
  for (const talker of talkers) if (talker.socket === socket) known = true;
  if (!known) {
    if (descriptorOf(socket) < 0) {
      directReads = false;
      return;
    }
    // A new voice: start over with it alone when the set is full, and let the set settle.
    if (talkers.length >= TALKERS_MAX) talkers = [];
    talkers.push({ socket, feed });
    talkersSince = started;
    return;
  }
  if (started - talkersSince < DIRECT_SETTLE_MS) return;
  const sliceEnd = started + DIRECT_SLICE_MS;
  let idleEnd = started + DIRECT_WAIT_MS;
  // An empty read throws; without this the runtime would record a stack trace for each one.
  const traceLimit = Error.stackTraceLimit;
  Error.stackTraceLimit = 0;
  try {
    // A client that alternates between connections sends its next request on another one
    // than the last, so each round starts after the connection that spoke last.
    let first = 0;
    for (;;) {
      let got = false;
      const count0 = talkers.length;
      for (let step = 0; step < count0; step += 1) {
        const at = (first + step) % count0;
        const talker = talkers[at]!;
        const fd = descriptorOf(talker.socket);
        if (fd < 0) {
          // A connection that is closing leaves the set; the event loop finishes it.
          dropTalker(talker);
          return;
        }
        let count: number;
        try {
          count = readSync(fd, directBuffer, 0, directBuffer.length, null);
        } catch (err) {
          const code = (err as { code?: unknown }).code;
          if (code === 'EAGAIN' || code === 'EWOULDBLOCK') continue;
          // A reset or closed connection is the event loop's to report; anything else is a
          // sign that direct reads do not work here.
          if (code !== 'ECONNRESET' && code !== 'EPIPE' && code !== 'ENOTCONN' && code !== 'EBADF') directReads = false;
          dropTalker(talker);
          return;
        }
        // End of stream: the event loop sees the same and closes the connection.
        if (count <= 0) {
          dropTalker(talker);
          return;
        }
        const chunk = Buffer.allocUnsafe(count);
        directBuffer.copy(chunk, 0, 0, count);
        talker.feed(chunk);
        got = true;
        first = (at + 1) % count0;
        break;
      }
      const now = performance.now();
      if (now > sliceEnd) return;
      if (got) idleEnd = now + DIRECT_WAIT_MS;
      else if (now > idleEnd) return;
    }
  } finally {
    Error.stackTraceLimit = traceLimit;
  }
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
