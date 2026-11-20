// pkt-line framing: four hex digits of length, then the payload. 0000 is a flush, 0001 a
// delimiter, 0002 a response end.

export const FLUSH = Buffer.from('0000', 'latin1');
export const DELIM = Buffer.from('0001', 'latin1');

/** The most payload one side-band packet may carry (65520 - 4 length digits - 1 band byte). */
const BAND_CHUNK = 65515;

const HEX = '0123456789abcdef';

function lengthPrefix(total: number): string {
  return HEX[(total >> 12) & 15]! + HEX[(total >> 8) & 15]! + HEX[(total >> 4) & 15]! + HEX[total & 15]!;
}

export function pkt(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const out = Buffer.allocUnsafe(body.length + 4);
  out.write(lengthPrefix(body.length + 4), 0, 'latin1');
  body.copy(out, 4);
  return out;
}

/** `data` on side-band `band`, split into as many packets as it needs. */
export function sideband(band: number, data: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let pos = 0; pos < data.length || pos === 0; pos += BAND_CHUNK) {
    const chunk = data.subarray(pos, pos + BAND_CHUNK);
    const out = Buffer.allocUnsafe(chunk.length + 5);
    out.write(lengthPrefix(chunk.length + 5), 0, 'latin1');
    out[4] = band;
    chunk.copy(out, 5);
    parts.push(out);
    if (data.length === 0) break;
  }
  return parts.length === 1 ? parts[0]! : Buffer.concat(parts);
}

export type Packet = { kind: 'flush' } | { kind: 'delim' } | { kind: 'end' } | { kind: 'data'; text: string };

export interface PacketRun {
  packets: Packet[];
  /** The offset just past the last packet read. */
  next: number;
}

/**
 * Read pkt-lines from `buf` starting at `pos`. With `stopAtFlush` the run ends after the first
 * flush packet (what follows a receive-pack command list is a raw pack, not pkt-lines).
 */
export function readPackets(buf: Buffer, pos: number, stopAtFlush: boolean): PacketRun {
  const packets: Packet[] = [];
  let at = pos;
  while (at < buf.length) {
    if (at + 4 > buf.length) throw new Error('truncated pkt-line length');
    const digits = buf.toString('latin1', at, at + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(digits)) throw new Error('bad pkt-line length');
    const length = parseInt(digits, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      at += 4;
      if (stopAtFlush) break;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      at += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'end' });
      at += 4;
      continue;
    }
    if (length < 4 || at + length > buf.length) throw new Error('pkt-line runs past the body');
    packets.push({ kind: 'data', text: buf.toString('utf8', at + 4, at + length) });
    at += length;
  }
  return { packets, next: at };
}
