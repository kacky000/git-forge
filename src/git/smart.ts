// Git smart HTTP: the ref advertisement, upload-pack (protocol v2, with a v0 fallback) and
// receive-pack (v0). Each entry point takes a request's parts and returns the whole reply.

import { findRepo, type Repo } from '../core/state.ts';
import { setRef } from '../core/repos.ts';
import { ZERO, getObject, hasObject, peel, peelToCommit } from './objects.ts';
import { isAncestor, planFetch, type FetchWant } from './graph.ts';
import { buildPack, ingestPack } from './pack.ts';
import { DELIM, FLUSH, pkt, readPackets, sideband, type Packet } from './pkt.ts';

export interface GitReply {
  status: number;
  type: string;
  body: Buffer;
}

const AGENT = 'agent=git-forge/1.0';
const UPLOAD_CAPS_V0 = `side-band-64k side-band ofs-delta shallow no-progress include-tag allow-tip-sha1-in-want allow-reachable-sha1-in-want object-format=sha1 ${AGENT}`;
const RECEIVE_CAPS = `report-status delete-refs side-band-64k ofs-delta object-format=sha1 ${AGENT}`;
const V2_ADVERT = Buffer.concat([
  pkt('version 2\n'),
  pkt(`${AGENT}\n`),
  pkt('ls-refs=unborn\n'),
  pkt('fetch=shallow\n'),
  pkt('server-option\n'),
  pkt('object-format=sha1\n'),
  FLUSH,
]);

function plain(status: number, text: string): GitReply {
  return { status, type: 'text/plain; charset=utf-8', body: Buffer.from(text, 'utf8') };
}

function sortedRefs(repo: Repo): [string, string][] {
  return [...repo.refs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function headTarget(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

// ---------------------------------------------------------------- GET info/refs

function advertiseV0(repo: Repo, service: string): Buffer {
  const parts: Buffer[] = [pkt(`# service=${service}\n`), FLUSH];
  const upload = service === 'git-upload-pack';
  const caps = upload ? `${UPLOAD_CAPS_V0} symref=HEAD:${headTarget(repo)}` : RECEIVE_CAPS;
  const lines: string[] = [];
  const head = repo.refs.get(headTarget(repo));
  if (upload && head !== undefined) lines.push(`${head} HEAD`);
  for (const [ref, oid] of sortedRefs(repo)) {
    lines.push(`${oid} ${ref}`);
    if (upload && getObject(oid)?.type === 'tag') {
      const target = peel(oid);
      if (target !== null) lines.push(`${target} ${ref}^{}`);
    }
  }
  if (lines.length === 0) parts.push(pkt(`${ZERO} capabilities^{}\0${caps}\n`));
  else lines.forEach((line, index) => parts.push(pkt(index === 0 ? `${line}\0${caps}\n` : `${line}\n`)));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

export function infoRefs(owner: string, name: string, service: string | null, protocol: string | undefined): GitReply {
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return plain(403, 'dumb HTTP transport is not supported\n');
  const repo = findRepo(owner, name);
  if (repo === undefined) return plain(404, 'Repository not found.\n');
  const type = `application/x-${service}-advertisement`;
  if (service === 'git-upload-pack' && protocol !== undefined && /(^|:)\s*version=2\b/.test(protocol)) return { status: 200, type, body: V2_ADVERT };
  const cached = repo.adCache.get(service);
  if (cached !== undefined && cached.version === repo.refsVersion) return { status: 200, type, body: cached.body };
  const body = advertiseV0(repo, service);
  repo.adCache.set(service, { version: repo.refsVersion, body });
  return { status: 200, type, body };
}

// ---------------------------------------------------------------- POST git-upload-pack

function lsRefs(repo: Repo, args: string[]): Buffer {
  const cacheKey = `ls\n${args.join('\n')}`;
  const cached = repo.adCache.get(cacheKey);
  if (cached !== undefined && cached.version === repo.refsVersion) return cached.body;
  let peelTags = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peelTags = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice(11));
  }
  const wanted = (ref: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => ref.startsWith(prefix));
  const parts: Buffer[] = [];
  if (wanted('HEAD')) {
    const target = headTarget(repo);
    const head = repo.refs.get(target);
    if (head !== undefined) parts.push(pkt(`${head} HEAD${symrefs ? ` symref-target:${target}` : ''}\n`));
    else if (unborn) parts.push(pkt(`unborn HEAD${symrefs ? ` symref-target:${target}` : ''}\n`));
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    if (!wanted(ref)) continue;
    let line = `${oid} ${ref}`;
    if (peelTags && getObject(oid)?.type === 'tag') {
      const target = peel(oid);
      if (target !== null) line += ` peeled:${target}`;
    }
    parts.push(pkt(`${line}\n`));
  }
  parts.push(FLUSH);
  const body = Buffer.concat(parts);
  if (repo.adCache.size > 64) repo.adCache.clear();
  repo.adCache.set(cacheKey, { version: repo.refsVersion, body });
  return body;
}

interface FetchArgs extends FetchWant {
  done: boolean;
}

function fetchArgs(lines: string[], repo: Repo): FetchArgs {
  const out: FetchArgs = { wants: [], haves: [], shallow: [], depth: 0, done: false };
  for (const raw of lines) {
    const line = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
    if (line.startsWith('want ')) out.wants.push(line.slice(5, 45).toLowerCase());
    else if (line.startsWith('want-ref ')) {
      const oid = repo.refs.get(line.slice(9));
      if (oid !== undefined) out.wants.push(oid);
    } else if (line.startsWith('have ')) out.haves.push(line.slice(5, 45).toLowerCase());
    else if (line.startsWith('shallow ')) out.shallow.push(line.slice(8, 48).toLowerCase());
    else if (line.startsWith('deepen ')) out.depth = Math.max(0, Number(line.slice(7)) || 0);
    else if (line === 'deepen-relative') out.relative = true;
    else if (line === 'done') out.done = true;
  }
  return out;
}

/** Whole fetch replies for requests that name no `have`: a clone's answer never changes. */
const cloneCache = new Map<string, Buffer>();

function fetchV2(repo: Repo, lines: string[]): Buffer {
  const args = fetchArgs(lines, repo);
  const cacheable = args.haves.length === 0;
  const key = cacheable ? `${args.wants.join(',')}|${args.shallow.join(',')}|${args.depth}${args.relative === true ? 'r' : ''}|${args.done ? 1 : 0}` : '';
  if (cacheable) {
    const hit = cloneCache.get(key);
    if (hit !== undefined) return hit;
  }
  const plan = planFetch(args);
  const parts: Buffer[] = [];
  if (!args.done) {
    parts.push(pkt('acknowledgments\n'));
    if (plan.common.length === 0) parts.push(pkt('NAK\n'));
    for (const oid of plan.common) parts.push(pkt(`ACK ${oid}\n`));
    parts.push(pkt('ready\n'), DELIM);
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pkt('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pkt(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
    parts.push(DELIM);
  }
  parts.push(pkt('packfile\n'), sideband(1, buildPack(plan.oids)), FLUSH);
  const body = Buffer.concat(parts);
  if (cacheable) {
    if (cloneCache.size >= 256) cloneCache.clear();
    cloneCache.set(key, body);
  }
  return body;
}

function fetchV0(repo: Repo, packets: Packet[]): Buffer {
  const lines: string[] = [];
  let caps = '';
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let text = packet.text;
    if (text.startsWith('want ') && caps === '' && text.length > 46) {
      caps = text.slice(45);
      text = text.slice(0, 45);
    }
    lines.push(text);
  }
  const args = fetchArgs(lines, repo);
  const plan = planFetch(args);
  const parts: Buffer[] = [];
  if (args.depth > 0) {
    for (const oid of plan.shallow) parts.push(pkt(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
    parts.push(FLUSH);
  }
  const last = plan.common[plan.common.length - 1];
  parts.push(pkt(last === undefined ? 'NAK\n' : `ACK ${last}\n`));
  const pack = buildPack(plan.oids);
  if (/\bside-band(-64k)?\b/.test(caps)) parts.push(sideband(1, pack), FLUSH);
  else parts.push(pack);
  return Buffer.concat(parts);
}

export function uploadPack(owner: string, name: string, body: Buffer): GitReply {
  const repo = findRepo(owner, name);
  if (repo === undefined) return plain(404, 'Repository not found.\n');
  const type = 'application/x-git-upload-pack-result';
  let packets: Packet[];
  try {
    packets = readPackets(body, 0, false).packets;
  } catch (err) {
    return plain(400, `bad request: ${err instanceof Error ? err.message : 'malformed pkt-line'}\n`);
  }
  const first = packets.find((packet) => packet.kind === 'data');
  if (first === undefined || first.kind !== 'data') return plain(400, 'bad request: empty upload-pack request\n');
  try {
    if (first.text.startsWith('command=')) {
      const command = first.text.slice(8).trim();
      const args: string[] = [];
      let inArgs = false;
      for (const packet of packets) {
        if (packet.kind === 'delim') inArgs = true;
        else if (packet.kind === 'flush') break;
        else if (packet.kind === 'data' && inArgs) args.push(packet.text.endsWith('\n') ? packet.text.slice(0, -1) : packet.text);
      }
      if (command === 'ls-refs') return { status: 200, type, body: lsRefs(repo, args) };
      if (command === 'fetch') return { status: 200, type, body: fetchV2(repo, args) };
      return { status: 200, type, body: Buffer.concat([pkt(`ERR unknown command ${command}\n`)]) };
    }
    if (!first.text.startsWith('want ')) return plain(400, 'bad request: expected a want line or a command\n');
    return { status: 200, type, body: fetchV0(repo, packets) };
  } catch (err) {
    return { status: 200, type, body: pkt(`ERR upload-pack: ${err instanceof Error ? err.message : 'failed'}\n`) };
  }
}

// ---------------------------------------------------------------- POST git-receive-pack

interface RefCommand {
  from: string;
  to: string;
  ref: string;
}

/** Why a command is refused, or null when it may be applied. */
function refusal(repo: Repo, command: RefCommand): string | null {
  if (!command.ref.startsWith('refs/') || /[\s~^:?*[\\]|\.\.|\/\/|\/$|@\{/.test(command.ref)) return 'funny refname';
  const current = repo.refs.get(command.ref);
  if (command.to === ZERO) return current === undefined ? null : null;
  if (!hasObject(command.to)) return 'missing necessary objects';
  if (current === undefined || current === command.to) return null;
  const from = peelToCommit(current);
  const to = peelToCommit(command.to);
  if (from === null || to === null || !isAncestor(from, to)) return 'non-fast-forward';
  return null;
}

export function receivePack(owner: string, name: string, body: Buffer): GitReply {
  const repo = findRepo(owner, name);
  if (repo === undefined) return plain(404, 'Repository not found.\n');
  const type = 'application/x-git-receive-pack-result';
  let commands: RefCommand[] = [];
  let caps = '';
  let rest = 0;
  try {
    const run = readPackets(body, 0, true);
    rest = run.next;
    for (const packet of run.packets) {
      if (packet.kind !== 'data') continue;
      let text = packet.text.endsWith('\n') ? packet.text.slice(0, -1) : packet.text;
      const nul = text.indexOf('\0');
      if (nul >= 0) {
        caps = text.slice(nul + 1);
        text = text.slice(0, nul);
      }
      if (text.startsWith('shallow ') || text.startsWith('push-cert')) continue;
      const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/i.exec(text);
      if (match === null) throw new Error('malformed command');
      commands.push({ from: match[1]!.toLowerCase(), to: match[2]!.toLowerCase(), ref: match[3]! });
    }
  } catch (err) {
    return plain(400, `bad request: ${err instanceof Error ? err.message : 'malformed pkt-line'}\n`);
  }
  if (commands.length === 0) return plain(400, 'bad request: no ref commands\n');

  let unpack = 'ok';
  if (rest < body.length) {
    try {
      ingestPack(body.subarray(rest));
    } catch (err) {
      unpack = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  const report: Buffer[] = [pkt(`unpack ${unpack}\n`)];
  // A ref named twice in one push is judged once, by its last command.
  commands = commands.filter((command, index) => commands.findIndex((other) => other.ref === command.ref) === index);
  for (const command of commands) {
    const why = unpack === 'ok' ? refusal(repo, command) : 'unpacker error';
    if (why !== null) {
      report.push(pkt(`ng ${command.ref} ${why}\n`));
      continue;
    }
    setRef(repo, command.ref, command.to === ZERO ? null : command.to);
    report.push(pkt(`ok ${command.ref}\n`));
  }
  report.push(FLUSH);
  // The first branch pushed into a repository whose default branch does not exist becomes it.
  if (!repo.refs.has(headTarget(repo))) {
    const firstHead = commands.find((command) => command.ref.startsWith('refs/heads/') && repo.refs.has(command.ref));
    if (firstHead !== undefined && ![...repo.refs.keys()].some((ref) => ref.startsWith('refs/heads/') && ref !== firstHead.ref)) {
      repo.defaultBranch = firstHead.ref.slice(11);
      repo.refsVersion += 1;
    }
  }
  const flat = Buffer.concat(report);
  if (/\bside-band(-64k)?\b/.test(caps)) return { status: 200, type, body: Buffer.concat([sideband(1, flat), FLUSH]) };
  return { status: 200, type, body: flat };
}
