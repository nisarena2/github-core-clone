// The forge's store: every repository, git object, issue, pull request, label
// and comment lives here, in memory, under one owner — the login the bearer
// token names. Nothing is written to disk and nothing leaves the process.
//
// Time is a logical clock, never the wall clock: it starts at the trial's
// opening time (MAKEFUN_TRIAL_NOW) and ticks one second per stamp, so two runs
// of one trial stamp the same events in the same order.

import { createHash } from 'node:crypto';
import { VIEWER } from './scenario.ts';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: ObjectType;
  readonly data: Buffer;
}

export function hashObject(type: ObjectType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(head).update(data).digest('hex');
}

export function objectId(type: ObjectType, data: Buffer): string {
  return hashObject(type, data);
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  body: string;
  user: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: Comment[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  createdAt: string;
  updatedAt: string;
}

/** One file in a commit's snapshot: its blob and mode. */
export interface SnapshotEntry {
  oid: string;
  mode: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  /** ref name (refs/heads/..., refs/tags/...) -> tip oid. */
  refs: Map<string, string>;
  /** oid -> object. */
  objects: Map<string, GitObject>;
  /** commit oid -> snapshot (path -> entry). Kept beside the objects so a tree never has to be re-read. */
  snapshots: Map<string, Map<string, SnapshotEntry>>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: Pull[];
  /** One counter for issues and pull requests, as on the real forge. */
  numberSeq: number;
  commentSeq: number;
  createdAt: string;
  updatedAt: string;
}

const ZERO_OID = '0'.repeat(40);
export { ZERO_OID };

/** A commit's parsed headers, enough to walk parents and trees. */
export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(tree: string, parents: string[], author: string, committer: string, message: string): Buffer {
  const lines: string[] = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${author}`, `committer ${committer}`, '', message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = entries.slice().sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

export function buildTag(target: string, type: ObjectType, tag: string, tagger: string, message: string): Buffer {
  return Buffer.from(`object ${target}\ntype ${type}\ntag ${tag}\ntagger ${tagger}\n\n${message}`, 'utf8');
}

/** The store itself. */
export class Store {
  readonly viewerLogin = VIEWER.login;
  readonly viewerId = VIEWER.id;
  readonly viewerName = VIEWER.name;
  readonly viewerEmail = VIEWER.email;

  /** Logical clock: seconds since the trial opened. */
  #clockSec: number;
  #requestSeq = 0;
  #repoSeq = 0;
  #objectSeq = 0;
  readonly repos = new Map<string, Repo>();

  constructor() {
    const now = process.env.MAKEFUN_TRIAL_NOW ?? '';
    const parsed = now === '' ? NaN : Date.parse(now);
    this.#clockSec = Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 1_762_396_800;
  }

  /** The next request id: deterministic, one per request in order. */
  nextRequestId(): string {
    this.#requestSeq += 1;
    return `req-${String(this.#requestSeq).padStart(6, '0')}`;
  }

  /** The next timestamp, one second after the previous stamp. */
  stamp(): string {
    this.#clockSec += 1;
    return new Date(this.#clockSec * 1000).toISOString();
  }

  /** The identity a commit the forge writes carries. */
  identity(): string {
    return `${this.viewerName} <${this.viewerEmail}> ${this.#clockSec} +0000`;
  }

  /** The epoch second the clock stands at (for commit headers). */
  get clockSec(): number {
    return this.#clockSec;
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo | null {
    if (this.repos.has(name)) return null;
    this.#repoSeq += 1;
    const at = this.stamp();
    const repo: Repo = {
      id: this.#repoSeq,
      name,
      owner: this.viewerLogin,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      refs: new Map(),
      objects: new Map(),
      snapshots: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      numberSeq: 0,
      commentSeq: 0,
      createdAt: at,
      updatedAt: at,
    };
    this.repos.set(name, repo);
    return repo;
  }

  /** Look a repository up by owner and name; a foreign owner never matches. */
  repo(owner: string, name: string): Repo | null {
    if (owner !== this.viewerLogin) return null;
    return this.repos.get(name) ?? null;
  }

  deleteRepo(name: string): boolean {
    return this.repos.delete(name);
  }

  listRepos(): Repo[] {
    return [...this.repos.values()];
  }

  nextObjectSeq(): number {
    this.#objectSeq += 1;
    return this.#objectSeq;
  }

  /** Store an object, returning its id. */
  putObject(repo: Repo, type: ObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  /** Build the tree objects for a snapshot, bottom-up; returns the root tree id. */
  writeSnapshotTrees(repo: Repo, snapshot: Map<string, SnapshotEntry>): string {
    interface Node {
      files: Map<string, SnapshotEntry>;
      dirs: Map<string, Node>;
    }
    const root: Node = { files: new Map(), dirs: new Map() };
    for (const [path, entry] of [...snapshot.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const parts = path.split('/');
      let node = root;
      for (let i = 0; i < parts.length - 1; i += 1) {
        const part = parts[i];
        let child = node.dirs.get(part);
        if (child === undefined) {
          child = { files: new Map(), dirs: new Map() };
          node.dirs.set(part, child);
        }
        node = child;
      }
      node.files.set(parts[parts.length - 1], entry);
    }
    const writeNode = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: writeNode(child) });
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return writeNode(root);
  }

  /** The snapshot at a ref tip, or null when the ref does not exist. */
  snapshotAt(repo: Repo, ref: string): Map<string, SnapshotEntry> | null {
    const tip = repo.refs.get(ref);
    if (tip === undefined) return null;
    return repo.snapshots.get(tip) ?? null;
  }

  /**
   * Build a snapshot (path -> blob) by walking the tree objects at a commit's
   * root tree. Used after a git push, where no REST snapshot was recorded.
   */
  snapshotFromTree(repo: Repo, treeOid: string): Map<string, SnapshotEntry> {
    const out = new Map<string, SnapshotEntry>();
    const walk = (oid: string, prefix: string): void => {
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Record the snapshot for a commit id from its own tree, if not present. */
  ensureSnapshot(repo: Repo, commitOid: string): void {
    if (repo.snapshots.has(commitOid)) return;
    const tree = this.commitTree(repo, commitOid);
    if (tree === null) return;
    repo.snapshots.set(commitOid, this.snapshotFromTree(repo, tree));
  }

  /** Walk a commit's ancestors, newest first, following first parents only. */
  ancestors(repo: Repo, tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    let current: string | null = tip;
    while (current !== null && current !== ZERO_OID && !seen.has(current)) {
      seen.add(current);
      out.push(current);
      const object = repo.objects.get(current);
      if (object === undefined || object.type !== 'commit') break;
      const parsed = parseCommit(object.data);
      current = parsed.parents.length > 0 ? parsed.parents[0] : null;
    }
    return out;
  }

  /** Every commit reachable from a tip (all parents), newest first by walk order. */
  reachableCommits(repo: Repo, tip: string): Set<string> {
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (oid === ZERO_OID || seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) stack.push(parent);
    }
    return seen;
  }

  /** Is `ancestor` reachable from `tip` (a fast-forward check)? */
  isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
    if (ancestor === tip) return true;
    return this.reachableCommits(repo, tip).has(ancestor);
  }

  /** The first common ancestor of two tips, or null. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const fromA = this.reachableCommits(repo, a);
    const queue = [b];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (oid === ZERO_OID || seen.has(oid)) continue;
      seen.add(oid);
      if (fromA.has(oid)) return oid;
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return null;
  }

  /** The tree id a commit points at, or null. */
  commitTree(repo: Repo, commitOid: string): string | null {
    const object = repo.objects.get(commitOid);
    if (object === undefined || object.type !== 'commit') return null;
    return parseCommit(object.data).tree;
  }
}
