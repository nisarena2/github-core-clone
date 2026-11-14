// git smart HTTP at /{owner}/{repo}.git: info/refs, git-upload-pack (protocol
// v2 and v0) and git-receive-pack (v0). The client speaks the protocol in
// process, so every byte here is judged by the pack parser on the other end.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  advertisedRefs,
  decodePktLines,
  objectsForFetch,
  packAfterFlush,
  pktDelim,
  pktFlush,
  pktLine,
  readPack,
  sidebandPack,
  writePack,
  type AdvertisedRef,
} from './git.ts';
import { queryOf, readBody } from './http.ts';
import { hashObject, type Repo, Store, ZERO_OID } from './store.ts';

const UPLOAD_AD_CT = 'application/x-git-upload-pack-advertisement';
const RECEIVE_AD_CT = 'application/x-git-receive-pack-advertisement';
const UPLOAD_REQ_CT = 'application/x-git-upload-pack-request';
const UPLOAD_RES_CT = 'application/x-git-upload-pack-result';
const RECEIVE_REQ_CT = 'application/x-git-receive-pack-request';
const RECEIVE_RES_CT = 'application/x-git-receive-pack-result';
const AGENT = 'forge/0.1.0';

function sendBytes(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function sendJsonError(res: ServerResponse, status: number, message: string): void {
  const text = `${JSON.stringify({ message })}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function refLine(ref: AdvertisedRef, capabilities: string | null): Buffer {
  const attrs: string[] = [];
  if (ref.symrefTarget !== undefined) attrs.push(`symref-target:${ref.symrefTarget}`);
  if (ref.peeled !== undefined) attrs.push(`peeled:${ref.peeled}`);
  const text = ref.unborn === true
    ? `unborn ${ref.name}${attrs.length > 0 ? ` ${attrs.join(' ')}` : ''}\n`
    : `${ref.oid} ${ref.name}${attrs.length > 0 ? ` ${attrs.join(' ')}` : ''}\n`;
  return pktLine(text);
}

/** A v0 advertisement: preamble, ref lines (first carries capabilities), flush. */
function v0Advertisement(service: string, refs: AdvertisedRef[], capabilities: string): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  // An empty repo (no real refs, only an unborn HEAD) advertises a single
  // bare zero line with no symref: the client must not chase a branch. The
  // capability list still rides after the NUL on that line, or the client
  // sends no capabilities at all (and then expects no report-status either).
  if (refs.length === 0 || refs.every((ref) => ref.unborn === true)) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${capabilities}\n`));
    parts.push(pktFlush());
    return Buffer.concat(parts);
  }
  refs.forEach((ref, index) => {
    // v0 ref lines are bare "<oid> <name>"; the symref rides in the capability
    // and peeled tags ride as separate "<oid> <name>^{}" lines. An unborn ref
    // is a zero oid, which the client reads as unborn.
    const text = `${ref.oid} ${ref.name}\n`;
    if (index === 0) {
      parts.push(pktLine(`${text.slice(0, -1)}\0${capabilities}\n`));
    } else {
      parts.push(pktLine(text));
    }
  });
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** The v2 capability advertisement. */
function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow filter\n'),
    pktLine('object-format=sha1\n'),
    pktLine(`agent=${AGENT}\n`),
    pktFlush(),
  ]);
}

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  thinPack: boolean;
  done: boolean;
}

function parseV2Request(lines: Array<Buffer | null | 'delim'>): { command: string; args: Map<string, string[]>; fetch: FetchRequest } {
  let command = '';
  const args = new Map<string, string[]>();
  const fetch: FetchRequest = { wants: [], haves: [], shallow: [], depth: null, thinPack: true, done: false };
  for (const item of lines) {
    if (item === null || item === 'delim') continue;
    const line = item.toString('utf8').replace(/\n$/, '');
    const [key, ...rest] = line.split(' ');
    const value = rest.join(' ');
    if (key.startsWith('command=')) {
      command = key.slice('command='.length);
      continue;
    }
    const list = args.get(key) ?? [];
    list.push(value);
    args.set(key, list);
    if (key === 'want') fetch.wants.push(value);
    else if (key === 'have') fetch.haves.push(value);
    else if (key === 'shallow') fetch.shallow.push(value);
    else if (key === 'deepen') fetch.depth = Number.parseInt(value, 10);
    else if (key === 'thin-pack') fetch.thinPack = true;
    else if (key === 'done') fetch.done = true;
  }
  return { command, args, fetch };
}

function lsRefsResponse(store: Store, repo: Repo, args: Map<string, string[]>): Buffer {
  const wantPeel = args.has('peel');
  const wantSymrefs = args.has('symrefs');
  const wantUnborn = args.has('unborn');
  const prefixes = args.get('ref-prefix') ?? [];
  const parts: Buffer[] = [];
  for (const ref of advertisedRefs(repo)) {
    if (prefixes.length > 0 && !prefixes.some((prefix) => ref.name.startsWith(prefix))) continue;
    if (ref.unborn === true && !wantUnborn) continue;
    const attrs: string[] = [];
    if (wantSymrefs && ref.symrefTarget !== undefined) attrs.push(`symref-target:${ref.symrefTarget}`);
    if (wantPeel && ref.peeled !== undefined) attrs.push(`peeled:${ref.peeled}`);
    if (ref.unborn === true) {
      parts.push(pktLine(`unborn ${ref.name}${attrs.length > 0 ? ` ${attrs.join(' ')}` : ''}\n`));
    } else {
      parts.push(pktLine(`${ref.oid} ${ref.name}${attrs.length > 0 ? ` ${attrs.join(' ')}` : ''}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function fetchResponseV2(store: Store, repo: Repo, fetch: FetchRequest): Buffer {
  const { objects, shallow } = objectsForFetch(repo, fetch.wants, fetch.haves, fetch.depth, fetch.shallow);
  const unshallow = fetch.shallow.filter((oid) => !shallow.includes(oid));
  const parts: Buffer[] = [];
  // The acknowledgments section exists only when the client sent haves. With
  // no haves the reader goes straight to shallow-info / wanted-refs / packfile,
  // and an "acknowledgments" line there is a protocol error.
  if (fetch.haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    const acks = fetch.haves.filter((have) => {
      const object = repo.objects.get(have);
      if (object === undefined || object.type !== 'commit') return false;
      return fetch.wants.some((want) => store.isAncestor(repo, have, want));
    });
    if (acks.length === 0) {
      parts.push(pktLine('NAK\n'));
    } else {
      for (const ack of acks) parts.push(pktLine(`ACK ${ack}\n`));
    }
    // The acknowledgments section ends with "ready", then a delim packet.
    parts.push(pktLine('ready\n'));
    parts.push(pktDelim());
  }
  // Shallow info.
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  // Wanted refs.
  const wanted: Array<{ oid: string; name: string }> = [];
  for (const want of fetch.wants) {
    for (const [name, oid] of repo.refs) {
      if (oid === want) wanted.push({ oid, name });
    }
  }
  if (wanted.length > 0) {
    parts.push(pktLine('wanted-refs\n'));
    for (const entry of wanted) parts.push(pktLine(`${entry.oid} ${entry.name}\n`));
    parts.push(pktDelim());
  }
  // Packfile.
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandPack(writePack(objects)));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function fetchResponseV0(store: Store, repo: Repo, fetch: FetchRequest): Buffer {
  const { objects, shallow } = objectsForFetch(repo, fetch.wants, fetch.haves, fetch.depth, fetch.shallow);
  const unshallow = fetch.shallow.filter((oid) => !shallow.includes(oid));
  const parts: Buffer[] = [];
  // Shallow/unshallow lines come FIRST in a v0 response: a client that asked
  // for a deepen reads them before the ACK/NAK lines, and the section ends
  // with a flush — a NAK right after a shallow line is a protocol error.
  for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (fetch.depth !== null || shallow.length > 0 || unshallow.length > 0) parts.push(pktFlush());
  // A v0 fetch without `done` is a negotiation-phase request (the shallow
  // clone's first POST): it gets the shallow list and nothing else. The
  // client comes back with `done` for the ACK/NAK lines and the pack; sending
  // those in the first phase corrupts the second phase's response.
  if (!fetch.done) return Buffer.concat(parts);
  const acks = fetch.haves.filter((have) => {
    const object = repo.objects.get(have);
    if (object === undefined || object.type !== 'commit') return false;
    return fetch.wants.some((want) => store.isAncestor(repo, have, want));
  });
  if (acks.length === 0) {
    parts.push(pktLine('NAK\n'));
  } else {
    for (const ack of acks) parts.push(pktLine(`ACK ${ack}\n`));
  }
  parts.push(sidebandPack(writePack(objects)));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function parseV0FetchRequest(lines: Array<Buffer | null | 'delim'>): FetchRequest {
  const fetch: FetchRequest = { wants: [], haves: [], shallow: [], depth: null, thinPack: true, done: false };
  let firstWant = true;
  for (const item of lines) {
    if (item === null || item === 'delim') continue;
    const line = item.toString('utf8').replace(/\n$/, '');
    const [key, ...rest] = line.split(' ');
    const value = rest.join(' ');
    if (key === 'want') {
      // The first want line may carry capabilities after a space-joined tail;
      // the oid is the first token.
      const oid = value.split(' ')[0];
      fetch.wants.push(oid);
      firstWant = false;
    } else if (key === 'have') fetch.haves.push(value);
    else if (key === 'shallow') fetch.shallow.push(value);
    else if (key === 'deepen') fetch.depth = Number.parseInt(value, 10);
    else if (key === 'done') fetch.done = true;
  }
  void firstWant;
  return fetch;
}

export async function handleGit(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const query = queryOf(req);
  let pathname = '/';
  try {
    pathname = new URL(req.url ?? '/', 'http://forge').pathname;
  } catch {
    return false;
  }
  const match = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
  if (match === null) return false;
  const owner = decodeURIComponent(match[1]);
  const repoName = decodeURIComponent(match[2]);
  const action = match[3];
  const repo = store.repo(owner, repoName);
  if (repo === null) {
    sendJsonError(res, 404, 'Not Found');
    return true;
  }

  if (action === 'info/refs') {
    if (method !== 'GET') {
      sendJsonError(res, 405, 'Method Not Allowed');
      return true;
    }
    const service = query.get('service') ?? '';
    const refs = advertisedRefs(repo);
    if (service === 'git-upload-pack') {
      const protocol = req.headers['git-protocol'] ?? '';
      if (typeof protocol === 'string' && protocol.includes('version=2')) {
        sendBytes(res, 200, UPLOAD_AD_CT, v2Advertisement());
      } else {
        const caps = 'side-band-64k multi_ack_detailed thin-pack ofs-delta shallow symref=HEAD:refs/heads/main agent=forge/0.1.0';
        sendBytes(res, 200, UPLOAD_AD_CT, v0Advertisement('git-upload-pack', refs, caps));
      }
      return true;
    }
    if (service === 'git-receive-pack') {
      const caps = 'report-status side-band-64k delete-refs ofs-delta agent=forge/0.1.0';
      sendBytes(res, 200, RECEIVE_AD_CT, v0Advertisement('git-receive-pack', refs, caps));
      return true;
    }
    sendJsonError(res, 404, 'Not Found');
    return true;
  }

  if (action === 'git-upload-pack') {
    if (method !== 'POST') {
      sendJsonError(res, 405, 'Method Not Allowed');
      return true;
    }
    const body = await readBody(req, 64 * 1024 * 1024);
    const protocol = req.headers['git-protocol'] ?? '';
    if (typeof protocol === 'string' && protocol.includes('version=2')) {
      const lines = decodePktLines(body);
      const { command, args, fetch } = parseV2Request(lines);
      if (command === 'ls-refs') {
        sendBytes(res, 200, UPLOAD_RES_CT, lsRefsResponse(store, repo, args));
        return true;
      }
      if (command === 'fetch') {
        sendBytes(res, 200, UPLOAD_RES_CT, fetchResponseV2(store, repo, fetch));
        return true;
      }
      sendJsonError(res, 400, `Unknown upload-pack command ${command}`);
      return true;
    }
    const lines = decodePktLines(body);
    const fetch = parseV0FetchRequest(lines);
    sendBytes(res, 200, UPLOAD_RES_CT, fetchResponseV0(store, repo, fetch));
    return true;
  }

  if (action === 'git-receive-pack') {
    if (method !== 'POST') {
      sendJsonError(res, 405, 'Method Not Allowed');
      return true;
    }
    const body = await readBody(req, 64 * 1024 * 1024);
    const lines = decodePktLines(body);
    const commands: PushCommand[] = [];
    for (const item of lines) {
      if (item === null || item === 'delim') break;
      const text = item.toString('utf8').replace(/\n$/, '');
      const nul = text.indexOf('\0');
      const head = nul === -1 ? text : text.slice(0, nul);
      const parts = head.split(' ');
      if (parts.length >= 3) commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
    }
    const packBytes = packAfterFlush(body);
    const report: Array<{ ref: string; ok: boolean; reason: string }> = [];
    let unpackOk = true;
    let unpackDetail = 'ok';
    if (packBytes.length > 0) {
      try {
        const parsed = readPack(packBytes);
        if (!parsed.checksumOk) {
          unpackOk = false;
          unpackDetail = 'ng pack checksum mismatch';
        } else {
          for (const object of parsed.objects) {
            const oid = hashObject(object.type, object.data);
            if (!repo.objects.has(oid)) repo.objects.set(oid, object);
          }
        }
      } catch (err) {
        unpackOk = false;
        unpackDetail = `ng ${err instanceof Error ? err.message : 'unpack failed'}`;
      }
    }
    if (unpackOk) {
      for (const command of commands) {
        const result = applyPush(store, repo, command);
        report.push(result);
      }
    } else {
      for (const command of commands) report.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
    }
    // The report-status stream, pkt-lined inside sideband band 1. The stream
    // itself ends with a flush pkt-line, so the reader on the other end sees
    // a clean end; then the wire ends with a flush that closes the sideband.
    const reportLines: Buffer[] = [pktLine(`unpack ${unpackDetail}\n`)];
    for (const entry of report) {
      reportLines.push(pktLine(entry.ok ? `ok ${entry.ref}\n` : `ng ${entry.ref} ${entry.reason}\n`));
    }
    reportLines.push(pktFlush());
    const reportBody = Buffer.concat(reportLines);
    const out = Buffer.concat([sidebandPack(reportBody), pktFlush()]);
    sendBytes(res, 200, RECEIVE_RES_CT, out);
    return true;
  }

  return false;
}

function applyPush(
  store: Store,
  repo: Repo,
  command: PushCommand,
): { ref: string; ok: boolean; reason: string } {
  const { oldOid, newOid, ref } = command;
  const current = repo.refs.get(ref);
  if (oldOid === ZERO_OID && newOid === ZERO_OID) {
    return { ref, ok: false, reason: 'invalid command' };
  }
  if (oldOid === ZERO_OID) {
    // Create.
    if (current !== undefined) return { ref, ok: false, reason: 'already exists' };
    if (!repo.objects.has(newOid)) return { ref, ok: false, reason: 'object not found' };
    repo.refs.set(ref, newOid);
    repo.updatedAt = store.stamp();
    // A push carries no REST snapshot: derive one from the new tip's tree so
    // contents, issues and pulls see the same files the git client just sent.
    store.ensureSnapshot(repo, newOid);
    return { ref, ok: true, reason: '' };
  }
  if (newOid === ZERO_OID) {
    // Delete.
    if (current === undefined) return { ref, ok: false, reason: 'reference does not exist' };
    if (current !== oldOid) return { ref, ok: false, reason: 'old value does not match' };
    repo.refs.delete(ref);
    repo.updatedAt = store.stamp();
    return { ref, ok: true, reason: '' };
  }
  // Update.
  if (current === undefined) return { ref, ok: false, reason: 'reference does not exist' };
  if (current !== oldOid) return { ref, ok: false, reason: 'old value does not match' };
  if (newOid === oldOid) return { ref, ok: true, reason: '' };
  if (!repo.objects.has(newOid)) return { ref, ok: false, reason: 'object not found' };
  if (!store.isAncestor(repo, oldOid, newOid)) return { ref, ok: false, reason: 'non-fast-forward' };
  repo.refs.set(ref, newOid);
  repo.updatedAt = store.stamp();
  store.ensureSnapshot(repo, newOid);
  return { ref, ok: true, reason: '' };
}

export { UPLOAD_REQ_CT, RECEIVE_REQ_CT };
