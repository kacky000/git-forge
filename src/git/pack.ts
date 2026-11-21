// Packfiles: reading the packs a push carries (plain, ofs-delta and ref-delta entries) and
// writing the packs a fetch answers with.

import { createHash } from 'node:crypto';
import { constants, createInflate, inflateSync } from 'node:zlib';
import { deflated, getObject, needObject, putObject, type ObjType } from './objects.ts';

const TYPE_BY_CODE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const CODE_BY_TYPE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const OFS_DELTA = 6;
const REF_DELTA = 7;

interface Resolved {
  type: ObjType;
  data: Buffer;
}

interface Pending {
  offset: number;
  delta: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

/** The parts of a zlib stream object that one synchronous, whole-buffer inflate needs. */
interface InflateEngine {
  _handle: {
    writeSync(flush: number, input: Buffer, inOffset: number, inLength: number, output: Buffer, outOffset: number, outLength: number): void;
    reset(): void;
  } | null;
  /** After a write: [output bytes still free, input bytes not consumed]. */
  _writeState: Uint32Array;
  destroyed: boolean;
  on(event: 'error', listener: () => void): unknown;
}

let engine: InflateEngine | null = null;
/** Set once the runtime's zlib object turns out not to have the shape `quickInflate` relies on. */
let engineUnusable = false;

/**
 * Inflate one pack entry whose inflated size the entry header already told us, on one inflater
 * that is reset and reused. `inflateSync` builds and tears down a zlib object for every call,
 * which costs more than inflating a small object does; a push carries a few small objects, so
 * that set-up is most of the work. Returns null whenever anything is not exactly as expected
 * (a different runtime, a damaged or oversized stream), and the caller then uses `inflateSync`.
 */
function quickInflate(pack: Buffer, pos: number, size: number): { data: Buffer; used: number } | null {
  if (engineUnusable) return null;
  try {
    if (engine === null || engine.destroyed || engine._handle === null) {
      const made = createInflate() as unknown as InflateEngine;
      made.on('error', () => undefined);
      const handle = made._handle;
      if (handle === null || typeof handle.writeSync !== 'function' || typeof handle.reset !== 'function' || !(made._writeState instanceof Uint32Array)) {
        engineUnusable = true;
        return null;
      }
      engine = made;
    }
    const handle = engine._handle!;
    const state = engine._writeState;
    const available = pack.length - pos;
    // One spare byte of output shows a stream that inflates to more than its header declared.
    const out = Buffer.allocUnsafe(size + 1);
    handle.writeSync(constants.Z_FINISH, pack, pos, available, out, 0, size + 1);
    if (engine.destroyed || engine._handle === null) {
      engine = null;
      return null;
    }
    const produced = size + 1 - (state[0] as number);
    const used = available - (state[1] as number);
    handle.reset();
    if (produced !== size || used <= 0 || used > available) return null;
    return { data: out.subarray(0, size), used };
  } catch {
    engine = null;
    return null;
  }
}

/**
 * Inflate the zlib stream that starts at `pos`; `used` is how many packed bytes it occupied.
 * `size` is the inflated size the entry header declares.
 */
function inflateAt(pack: Buffer, pos: number, size: number): { data: Buffer; used: number } {
  const quick = quickInflate(pack, pos, size);
  if (quick !== null) return quick;
  const out = inflateSync(pack.subarray(pos), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  return { data: out.buffer, used: out.engine.bytesWritten };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const varint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos++] as number;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) return value;
    }
  };
  const baseSize = varint();
  const outSize = varint();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(outSize);
  let at = 0;
  while (pos < delta.length) {
    const op = delta[pos++] as number;
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) offset |= delta[pos++] as number;
      if (op & 0x02) offset |= (delta[pos++] as number) << 8;
      if (op & 0x04) offset |= (delta[pos++] as number) << 16;
      if (op & 0x08) offset += (delta[pos++] as number) * 0x1000000;
      if (op & 0x10) size |= delta[pos++] as number;
      if (op & 0x20) size |= (delta[pos++] as number) << 8;
      if (op & 0x40) size |= (delta[pos++] as number) << 16;
      if (size === 0) size = 0x10000;
      if (offset + size > base.length || at + size > outSize) throw new Error('delta copy out of range');
      base.copy(out, at, offset, offset + size);
      at += size;
    } else if (op !== 0) {
      if (pos + op > delta.length || at + op > outSize) throw new Error('delta insert out of range');
      delta.copy(out, at, pos, pos + op);
      pos += op;
      at += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (at !== outSize) throw new Error('delta result size mismatch');
  return out;
}

/**
 * Read a whole pack and store its objects. Returns the ids it stored. Throws on anything that
 * is not a well-formed, checksummed version 2/3 pack whose deltas all resolve.
 */
export function ingestPack(pack: Buffer): string[] {
  if (pack.length < 32 || pack.toString('latin1', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const end = pack.length - 20;
  const byOffset = new Map<number, Resolved>();
  const pending: Pending[] = [];
  const stored: string[] = [];
  let pos = 12;
  for (let index = 0; index < count; index += 1) {
    if (pos >= end) throw new Error('pack ends before its last object');
    const offset = pos;
    let byte = pack[pos++] as number;
    const code = (byte >> 4) & 7;
    // The entry header's size: 4 bits, then 7 bits a byte, least significant first.
    let size = byte & 0x0f;
    let scale = 16;
    while ((byte & 0x80) !== 0) {
      byte = pack[pos++] as number;
      size += (byte & 0x7f) * scale;
      scale *= 128;
    }
    if (code === OFS_DELTA) {
      byte = pack[pos++] as number;
      let back = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        byte = pack[pos++] as number;
        back = (back + 1) * 128 + (byte & 0x7f);
      }
      const { data, used } = inflateAt(pack, pos, size);
      pos += used;
      pending.push({ offset, delta: data, baseOffset: offset - back });
    } else if (code === REF_DELTA) {
      const baseOid = pack.toString('hex', pos, pos + 20);
      pos += 20;
      const { data, used } = inflateAt(pack, pos, size);
      pos += used;
      pending.push({ offset, delta: data, baseOid });
    } else {
      const type = TYPE_BY_CODE[code];
      if (type === undefined) throw new Error(`unknown pack object type ${code}`);
      const { data, used } = inflateAt(pack, pos, size);
      const z = pack.subarray(pos, pos + used);
      pos += used;
      byOffset.set(offset, { type, data });
      stored.push(putObject(type, data, z));
    }
  }
  if (pos !== end) throw new Error('pack has trailing bytes');
  const sum = createHash('sha1').update(pack.subarray(0, end)).digest();
  if (!sum.equals(pack.subarray(end))) throw new Error('pack checksum mismatch');

  // Deltas may name bases that are themselves deltas, in any order: resolve until none moves.
  let waiting = pending;
  while (waiting.length > 0) {
    const next: Pending[] = [];
    for (const item of waiting) {
      let base: Resolved | undefined;
      if (item.baseOffset !== undefined) base = byOffset.get(item.baseOffset);
      else if (item.baseOid !== undefined) {
        const known = getObject(item.baseOid);
        if (known !== undefined) base = { type: known.type, data: known.data };
      }
      if (base === undefined) {
        next.push(item);
        continue;
      }
      const data = applyDelta(base.data, item.delta);
      byOffset.set(item.offset, { type: base.type, data });
      stored.push(putObject(base.type, data));
    }
    if (next.length === waiting.length) throw new Error('pack has a delta whose base is missing');
    waiting = next;
  }
  return stored;
}

/** A version 2 pack of whole (undeltified) objects, in the order given. */
export function buildPack(oids: readonly string[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 'latin1');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(oids.length, 8);
  parts.push(header);
  for (const oid of oids) {
    const obj = needObject(oid);
    let size = obj.data.length;
    const head: number[] = [];
    let first = (CODE_BY_TYPE[obj.type] << 4) | (size & 0x0f);
    size = Math.floor(size / 16);
    while (size > 0) {
      head.push(first | 0x80);
      first = size & 0x7f;
      size = Math.floor(size / 128);
    }
    head.push(first);
    parts.push(Buffer.from(head), deflated(obj));
  }
  const hash = createHash('sha1');
  for (const part of parts) hash.update(part);
  parts.push(hash.digest());
  return Buffer.concat(parts);
}
