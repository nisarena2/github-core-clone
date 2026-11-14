// The git wire: pkt-line framing, packfiles and the object walk a fetch needs.
// Plain objects only — the client sends and accepts packs without deltas, so
// this file never has to resolve one.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { hashObject, parseCommit, parseTree, type GitObject, type ObjectType, type Repo, ZERO_OID } from './store.ts';

export const PKT_FLUSH = '0000';
export const PKT_DELIM = '0001';

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const head = Buffer.from((body.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export function pktFlush(): Buffer {
  return Buffer.from(PKT_FLUSH, 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from(PKT_DELIM, 'ascii');
}

/** Split a byte stream into pkt-line payloads (null = flush, 'delim' = delim). */
export function decodePktLines(bytes: Buffer): Array<Buffer | null | 'delim'> {
  const out: Array<Buffer | null | 'delim'> = [];
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const head = bytes.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const length = parseInt(head, 16);
    if (length === 0) {
      out.push(null);
      offset += 4;
      continue;
    }
    if (length === 1) {
      out.push('delim');
      offset += 4;
      continue;
    }
    if (length === 2) {
      offset += 4;
      continue;
    }
    if (offset + length > bytes.length) break;
    out.push(bytes.subarray(offset + 4, offset + length));
    offset += length;
  }
  return out;
}

/** The bytes after the pkt-line section of a receive-pack body: the packfile. */
export function packAfterFlush(bytes: Buffer): Buffer {
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const head = bytes.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const length = parseInt(head, 16);
    if (length === 0) {
      offset += 4;
      break;
    }
    if (length === 1 || length === 2) {
      offset += 4;
      continue;
    }
    if (offset + length > bytes.length) break;
    offset += length;
  }
  return bytes.subarray(offset);
}

const TYPE_CODES: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function packEntryHeader(type: ObjectType, size: number): Buffer {
  const code = TYPE_CODES[type];
  const bytes: number[] = [];
  let first = (code << 4) | (size & 0x0f);
  let remaining = Math.floor(size / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Write a pack of plain objects (no deltas), with its checksum trailer. */
export function writePack(objects: GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objects.length, 8);
  parts.push(head);
  for (const object of objects) {
    parts.push(packEntryHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

export interface ParsedPack {
  objects: GitObject[];
  checksumOk: boolean;
}

function sha1(bytes: Buffer): string {
  return createHash('sha1').update(bytes).digest('hex');
}

/** Read a packfile of plain objects; throws on a bad header, entry or trailer. */
export function readPack(pack: Buffer): ParsedPack {
  if (pack.length < 32) throw new Error(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20).toString('hex');
  const computed = sha1(pack.subarray(0, pack.length - 20));
  const objects: GitObject[] = [];
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    let byte = pack[offset];
    offset += 1;
    const code = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = pack[offset];
      offset += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    const type = CODE_TYPES[code];
    if (type === undefined) throw new Error(`pack entry ${i} has unknown type code ${code}`);
    if (code === 6 || code === 7) throw new Error(`pack entry ${i} is a delta, which this forge does not store`);
    const end = zlibStreamEnd(pack, offset);
    const inflated = inflateSync(pack.subarray(offset, end));
    if (inflated.length !== size) {
      throw new Error(`pack entry at ${entryOffset} declares ${size} bytes but inflated to ${inflated.length}`);
    }
    objects.push({ type, data: Buffer.from(inflated) });
    offset = end;
  }
  if (offset !== pack.length - 20) throw new Error(`pack has stray bytes before its trailer`);
  return { objects, checksumOk: trailer === computed };
}

/** Find where a zlib stream starting at `offset` ends, by trial inflation. */
function zlibStreamEnd(pack: Buffer, offset: number): number {
  // Binary search the smallest end that inflates cleanly.
  let low = offset + 1;
  let high = pack.length - 20;
  let found = high;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    try {
      inflateSync(pack.subarray(offset, mid));
      found = mid;
      high = mid - 1;
    } catch {
      low = mid + 1;
    }
  }
  return found;
}

/** One ref line for an advertisement. */
export interface AdvertisedRef {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

/** Every ref of a repository, in advertisement order, with HEAD first. */
export function advertisedRefs(repo: Repo): AdvertisedRef[] {
  const out: AdvertisedRef[] = [];
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headTarget);
  if (headOid !== undefined) {
    out.push({ oid: headOid, name: 'HEAD', symrefTarget: headTarget });
  } else {
    out.push({ oid: ZERO_OID, name: 'HEAD', symrefTarget: headTarget, unborn: true });
  }
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const ref: AdvertisedRef = { oid, name };
    if (name.startsWith('refs/tags/')) {
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'tag') {
        const text = object.data.toString('utf8');
        const match = /^object ([0-9a-f]{40})$/m.exec(text);
        if (match !== null) ref.peeled = match[1];
      }
    }
    out.push(ref);
    if (ref.peeled !== undefined) {
      out.push({ oid: ref.peeled, name: `${name}^{}` });
    }
  }
  return out;
}

/** The objects a fetch must send: reachable from the wants, minus what the client holds. */
export function objectsForFetch(
  repo: Repo,
  wants: string[],
  haves: string[],
  depth: number | null,
  previousShallow: string[] = [],
): { objects: GitObject[]; shallow: string[]; unshallow: string[]; previousShallow: string[] } {
  const boundaries = new Set(previousShallow);
  // Objects the client already holds: reachable from the haves, but never
  // below a shallow boundary the client declared — a shallow commit's parents
  // are not held, only the commit and its tree.
  const haveObjects = new Set<string>();
  for (const have of haves) collectBounded(repo, have, haveObjects, boundaries);

  // Commits within the depth limit, generation by generation.
  const included = new Map<string, number>();
  const queue: Array<{ oid: string; gen: number }> = wants.map((oid) => ({ oid, gen: 0 }));
  while (queue.length > 0) {
    const { oid, gen } = queue.shift() as { oid: string; gen: number };
    if (oid === ZERO_OID || included.has(oid)) continue;
    included.set(oid, gen);
    if (depth !== null && gen + 1 >= depth) continue;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, gen: gen + 1 });
  }

  // Shallow boundaries: included commits with a parent outside the included set.
  const shallow: string[] = [];
  for (const [oid] of included) {
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.length > 0 && parents.some((parent) => !included.has(parent))) shallow.push(oid);
  }

  // Objects to send: from each included commit not already held, its commit,
  // its tree and blobs, and parents only while they are themselves included.
  // A parent outside the included set is a shallow boundary: its history
  // stays out of the pack.
  const send = new Set<string>();
  for (const [oid] of included) {
    if (haveObjects.has(oid)) continue;
    collectIncluded(repo, oid, included, send);
  }
  for (const oid of haveObjects) send.delete(oid);

  const objects: GitObject[] = [];
  // Deterministic order: commits first (by generation, then oid), then trees, then blobs, then tags.
  const ordered = [...send].sort((a, b) => {
    const typeRank = (oid: string): number => {
      const object = repo.objects.get(oid);
      if (object === undefined) return 9;
      return object.type === 'commit' ? 0 : object.type === 'tree' ? 1 : object.type === 'blob' ? 2 : 3;
    };
    const rank = typeRank(a) - typeRank(b);
    if (rank !== 0) return rank;
    return a < b ? -1 : 1;
  });
  for (const oid of ordered) {
    const object = repo.objects.get(oid);
    if (object !== undefined) objects.push(object);
  }
  return { objects, shallow, unshallow: [], previousShallow: [] };
}

/** Reachable objects from `root`, but never below a boundary commit: a boundary
 *  contributes itself and its tree, never its parents. Used for the haves'
 *  objects when the client declared shallow boundaries. */
export function collectBounded(repo: Repo, root: string, out: Set<string>, boundaries: Set<string>): void {
  const stack = [root];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (oid === ZERO_OID || out.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    out.add(oid);
    if (object.type === 'commit') {
      const parsed = parseCommit(object.data);
      stack.push(parsed.tree);
      if (!boundaries.has(oid)) for (const parent of parsed.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') stack.push(entry.oid);
      }
    } else if (object.type === 'tag') {
      const text = object.data.toString('utf8');
      const match = /^object ([0-9a-f]{40})$/m.exec(text);
      if (match !== null) stack.push(match[1]);
    }
  }
}

/** Objects under an included commit: the commit, its tree and blobs, and
 *  parents only while they are themselves in `included`. A parent outside
 *  the included set is a shallow boundary and its history stays out. */
export function collectIncluded(repo: Repo, root: string, included: Map<string, number>, out: Set<string>): void {
  const stack = [root];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (oid === ZERO_OID || out.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    out.add(oid);
    if (object.type === 'commit') {
      const parsed = parseCommit(object.data);
      stack.push(parsed.tree);
      for (const parent of parsed.parents) if (included.has(parent)) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') stack.push(entry.oid);
      }
    } else if (object.type === 'tag') {
      const text = object.data.toString('utf8');
      const match = /^object ([0-9a-f]{40})$/m.exec(text);
      if (match !== null) stack.push(match[1]);
    }
  }
}

/** Add every object reachable from `root` (commit, tree, tag) to `out`. */
export function collectReachable(repo: Repo, root: string, out: Set<string>): void {
  const stack = [root];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (oid === ZERO_OID || out.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    out.add(oid);
    if (object.type === 'commit') {
      const parsed = parseCommit(object.data);
      stack.push(parsed.tree);
      for (const parent of parsed.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') stack.push(entry.oid);
      }
    } else if (object.type === 'tag') {
      const text = object.data.toString('utf8');
      const match = /^object ([0-9a-f]{40})$/m.exec(text);
      if (match !== null) stack.push(match[1]);
    }
  }
}

/** Wrap pack bytes in sideband band-1 packets, chunked to the pkt-line limit. */
export function sidebandPack(pack: Buffer): Buffer {
  const chunks: Buffer[] = [];
  const max = 65515;
  for (let offset = 0; offset < pack.length; offset += max) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + max));
    const framed = Buffer.concat([Buffer.from([1]), slice]);
    chunks.push(pktLine(framed));
  }
  if (pack.length === 0) chunks.push(pktLine(Buffer.from([1])));
  return Buffer.concat(chunks);
}

export { hashObject };
