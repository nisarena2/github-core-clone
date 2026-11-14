// The REST v3 surface under /api/v3: repositories, branches, commits,
// contents, labels, issues, comments and pull requests. Every reply is JSON
// with a request id; errors are JSON with a string message.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  base64Of,
  base64ToBytes,
  isRecord,
  pageOf,
  parseJsonBody,
  pathSegments,
  queryOf,
  readBody,
  sendError,
  sendJson,
} from './http.ts';
import {
  buildCommit,
  objectId,
  parseCommit,
  parseTree,
  type Issue,
  type Label,
  type Pull,
  type Repo,
  Store,
  ZERO_OID,
} from './store.ts';

export interface RestContext {
  store: Store;
  req: IncomingMessage;
  res: ServerResponse;
}

export function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: store.viewerId, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    html_url: `https://forge/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `https://forge/${repo.owner}/${repo.name}.git`,
    git_url: `git://forge/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@forge:${repo.owner}/${repo.name}.git`,
    homepage: null,
    language: null,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    size: 0,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
    license: null,
    topics: [],
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return { name: label.name, color: label.color, description: label.description };
}

export function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map(labelJson),
    user: { login: store.viewerLogin, id: store.viewerId, type: 'User' },
    assignee: null,
    assignees: [],
    locked: false,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    html_url: `https://forge/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

export function pullFiles(store: Store, repo: Repo, pull: Pull): Array<Record<string, unknown>> {
  const base = repo.snapshots.get(pull.baseSha);
  const head = repo.snapshots.get(pull.headSha);
  if (base === undefined || head === undefined) return [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  const files: Array<Record<string, unknown>> = [];
  for (const path of [...paths].sort()) {
    const inBase = base.get(path);
    const inHead = head.get(path);
    if (inBase !== undefined && inHead !== undefined && inBase.oid === inHead.oid) continue;
    const countLines = (oid: string): number => {
      const object = repo.objects.get(oid);
      if (object === undefined) return 0;
      const text = object.data.toString('utf8');
      if (text === '') return 0;
      return text.split('\n').length;
    };
    if (inBase === undefined && inHead !== undefined) {
      const additions = countLines(inHead.oid);
      files.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (inBase !== undefined && inHead === undefined) {
      const deletions = countLines(inBase.oid);
      files.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (inBase !== undefined && inHead !== undefined) {
      const additions = countLines(inHead.oid);
      const deletions = countLines(inBase.oid);
      files.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return files;
}

/** Is the pull conflicted: head and base both changed one file differently since the merge base? */
export function pullConflicted(store: Store, repo: Repo, pull: Pull): boolean {
  // The base tip is live: another pull may have merged since this one opened.
  const baseTipOid = repo.refs.get(branchRef(pull.baseRef)) ?? pull.baseSha;
  const base = store.mergeBase(repo, pull.headSha, baseTipOid);
  if (base === null) return false;
  const baseSnap = repo.snapshots.get(base);
  const headSnap = repo.snapshots.get(pull.headSha);
  const baseTipSnap = repo.snapshots.get(baseTipOid);
  if (baseSnap === undefined || headSnap === undefined || baseTipSnap === undefined) return false;
  const paths = new Set([...baseSnap.keys(), ...headSnap.keys(), ...baseTipSnap.keys()]);
  for (const path of paths) {
    const atBase = baseSnap.get(path)?.oid;
    const atHead = headSnap.get(path)?.oid;
    const atTip = baseTipSnap.get(path)?.oid;
    const headChanged = atHead !== atBase;
    const tipChanged = atTip !== atBase;
    if (headChanged && tipChanged && atHead !== atTip) return true;
  }
  return false;
}

export function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  const mergedAt = pull.merged ? pull.mergedAt : null;
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.mergeable,
    mergeable_state: pull.mergeable === 'MERGEABLE' ? 'clean' : pull.mergeable === 'CONFLICTING' ? 'dirty' : 'unknown',
    head: {
      ref: pull.headRef,
      sha: pull.headSha,
      repo: { name: repo.name, full_name: `${repo.owner}/${repo.name}`, owner: { login: repo.owner } },
    },
    base: {
      ref: pull.baseRef,
      sha: pull.baseSha,
      repo: { name: repo.name, full_name: `${repo.owner}/${repo.name}`, owner: { login: repo.owner } },
    },
    user: { login: store.viewerLogin, id: store.viewerId, type: 'User' },
    assignee: null,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    html_url: `https://forge/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function resolveRepo(ctx: RestContext, owner: string, name: string): Repo | null {
  return ctx.store.repo(owner, name);
}

function notFound(ctx: RestContext): void {
  sendError(ctx.store, ctx.res, 404, 'Not Found');
}

/** Read and parse a JSON request body; answers 400 on malformed JSON. */
async function jsonBody(ctx: RestContext): Promise<Record<string, unknown> | null> {
  const raw = await readBody(ctx.req);
  const parsed = parseJsonBody(raw);
  if (!parsed.ok) {
    sendError(ctx.store, ctx.res, 400, 'Malformed JSON in request body');
    return null;
  }
  if (!isRecord(parsed.value)) {
    sendError(ctx.store, ctx.res, 400, 'Request body must be a JSON object');
    return null;
  }
  return parsed.value;
}

function branchRef(branch: string): string {
  return `refs/heads/${branch}`;
}

/** Commit a new snapshot on a branch; returns the new commit id. */
function commitSnapshot(
  store: Store,
  repo: Repo,
  branch: string,
  snapshot: Map<string, { oid: string; mode: string }>,
  message: string,
): string {
  const tree = store.writeSnapshotTrees(repo, snapshot);
  const tip = repo.refs.get(branchRef(branch));
  const parents = tip !== undefined ? [tip] : [];
  const at = store.stamp();
  const identity = `${store.viewerName} <${store.viewerEmail}> ${store.clockSec} +0000`;
  const data = buildCommit(tree, parents, identity, identity, message);
  const oid = objectId('commit', data);
  store.putObject(repo, 'commit', data);
  repo.snapshots.set(oid, new Map(snapshot));
  repo.refs.set(branchRef(branch), oid);
  repo.updatedAt = at;
  return oid;
}

/** A merge that cannot happen, with the HTTP status the REST surface answers. */
export class MergeError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Squash-merge an open pull request onto its base branch: the head snapshot
 * becomes the new base tip. Throws MergeError when the pull is already closed,
 * conflicted, or has no head content. Shared by the REST merge route, the
 * GraphQL mergePullRequest mutation and the MCP merge_pull_request tool.
 */
export function mergePull(store: Store, repo: Repo, pull: Pull): { sha: string; message: string } {
  if (pull.state === 'closed') throw new MergeError(405, 'Pull request is already closed');
  if (pullConflicted(store, repo, pull)) {
    pull.mergeable = 'CONFLICTING';
    throw new MergeError(405, 'Pull request is conflicted and cannot be merged');
  }
  const headSnap = repo.snapshots.get(pull.headSha);
  if (headSnap === undefined) throw new MergeError(405, 'Head commit has no content');
  const message = `Merge pull request #${pull.number}: ${pull.title}`;
  const commitOid = commitSnapshot(store, repo, pull.baseRef, new Map(headSnap), message);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = store.stamp();
  pull.mergeCommitSha = commitOid;
  pull.updatedAt = pull.mergedAt;
  return { sha: commitOid, message };
}

export async function handleRest(ctx: RestContext): Promise<boolean> {
  const { store, req, res } = ctx;
  const segments = pathSegments(req);
  const method = req.method ?? 'GET';
  const query = queryOf(req);

  // GET /api/v3/ — the API root (no auth, like the starter).
  if (method === 'GET' && segments.length === 2 && segments[0] === 'api' && segments[1] === 'v3') {
    sendJson(store, res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  // GET /api/v3/meta — the installed version.
  if (method === 'GET' && segments.length === 3 && segments[0] === 'api' && segments[1] === 'v3' && segments[2] === 'meta') {
    sendJson(store, res, 200, { installed_version: '1.0.0', verifiable_password_authentication: true });
    return true;
  }

  if (segments.length < 2 || segments[0] !== 'api' || segments[1] !== 'v3') return false;

  // GET /api/v3/user — the token owner.
  if (method === 'GET' && segments.length === 3 && segments[2] === 'user') {
    sendJson(store, res, 200, {
      login: store.viewerLogin,
      id: store.viewerId,
      name: store.viewerName,
      email: store.viewerEmail,
      type: 'User',
    });
    return true;
  }

  // GET /api/v3/user/repos — paginated list.
  if (segments.length === 4 && segments[2] === 'user' && segments[3] === 'repos') {
    if (method === 'GET') {
      const { page, link } = pageOf(req, store.listRepos().map((repo) => repoJson(store, repo)), query);
      sendJson(store, res, 200, page, link !== null ? { link } : {});
      return true;
    }
    if (method === 'POST') {
      const body = await jsonBody(ctx);
      if (body === null) return true;
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') {
        sendError(store, res, 422, 'Repository name is required');
        return true;
      }
      const description = typeof body.description === 'string' ? body.description : '';
      const isPrivate = body.private === true;
      const repo = store.createRepo(name, description, isPrivate);
      if (repo === null) {
        sendError(store, res, 422, 'Repository already exists');
        return true;
      }
      sendJson(store, res, 201, repoJson(store, repo));
      return true;
    }
    return false;
  }

  // /api/v3/repos/{owner}/{repo}/...
  if (segments.length >= 5 && segments[2] === 'repos') {
    const owner = segments[3];
    const name = segments[4];
    const rest = segments.slice(5);

    // GET / PATCH / DELETE /api/v3/repos/{owner}/{repo}
    if (rest.length === 0) {
      if (method === 'GET') {
        const repo = resolveRepo(ctx, owner, name);
        if (repo === null) {
          notFound(ctx);
          return true;
        }
        sendJson(store, res, 200, repoJson(store, repo));
        return true;
      }
      if (method === 'PATCH') {
        const repo = resolveRepo(ctx, owner, name);
        if (repo === null) {
          notFound(ctx);
          return true;
        }
        const body = await jsonBody(ctx);
        if (body === null) return true;
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.defaultBranch = body.default_branch;
        repo.updatedAt = store.stamp();
        sendJson(store, res, 200, repoJson(store, repo));
        return true;
      }
      if (method === 'DELETE') {
        const repo = resolveRepo(ctx, owner, name);
        if (repo === null) {
          notFound(ctx);
          return true;
        }
        store.deleteRepo(name);
        res.writeHead(204, { 'x-github-request-id': store.nextRequestId() });
        res.end();
        return true;
      }
      return false;
    }

    const repo = resolveRepo(ctx, owner, name);
    if (repo === null) {
      notFound(ctx);
      return true;
    }

    // GET /api/v3/repos/{o}/{r}/branches
    if (rest.length === 1 && rest[0] === 'branches' && method === 'GET') {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .sort()
        .map((ref) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: repo.refs.get(ref) as string } }));
      sendJson(store, res, 200, branches);
      return true;
    }

    // POST /api/v3/repos/{o}/{r}/git/refs
    if (rest.length === 2 && rest[0] === 'git' && rest[1] === 'refs' && method === 'POST') {
      const body = await jsonBody(ctx);
      if (body === null) return true;
      const ref = typeof body.ref === 'string' ? body.ref : '';
      const sha = typeof body.sha === 'string' ? body.sha : '';
      if (!/^refs\//.test(ref) || !/^[0-9a-f]{40}$/.test(sha)) {
        sendError(store, res, 422, 'Invalid ref or sha');
        return true;
      }
      if (repo.refs.has(ref)) {
        sendError(store, res, 422, 'Reference already exists');
        return true;
      }
      if (!repo.objects.has(sha)) {
        sendError(store, res, 422, 'Object does not exist');
        return true;
      }
      repo.refs.set(ref, sha);
      sendJson(store, res, 201, { ref, object: { sha } });
      return true;
    }

    // GET /api/v3/repos/{o}/{r}/commits
    if (rest.length === 1 && rest[0] === 'commits' && method === 'GET') {
      const shaParam = query.get('sha');
      let tip: string | undefined;
      if (shaParam !== null && shaParam !== '') {
        tip = /^[0-9a-f]{40}$/.test(shaParam) ? shaParam : repo.refs.get(branchRef(shaParam));
      } else {
        tip = repo.refs.get(branchRef(repo.defaultBranch));
      }
      const commits: Array<Record<string, unknown>> = [];
      if (tip !== undefined) {
        for (const oid of store.ancestors(repo, tip)) {
          const object = repo.objects.get(oid);
          if (object === undefined || object.type !== 'commit') continue;
          const parsed = parseCommit(object.data);
          commits.push({
            sha: oid,
            commit: {
              message: parsed.message,
              author: { name: store.viewerName, email: store.viewerEmail },
              committer: { name: store.viewerName, email: store.viewerEmail },
            },
            parents: parsed.parents.map((parent) => ({ sha: parent })),
          });
        }
      }
      sendJson(store, res, 200, commits);
      return true;
    }

    // /api/v3/repos/{o}/{r}/contents/{path...}
    if (rest.length >= 1 && rest[0] === 'contents') {
      return handleContents(ctx, repo, rest.slice(1), query);
    }

    // POST / GET /api/v3/repos/{o}/{r}/labels
    if (rest.length === 1 && rest[0] === 'labels') {
      if (method === 'POST') {
        const body = await jsonBody(ctx);
        if (body === null) return true;
        const labelName = typeof body.name === 'string' ? body.name : '';
        if (labelName === '') {
          sendError(store, res, 422, 'Label name is required');
          return true;
        }
        if (repo.labels.has(labelName)) {
          sendError(store, res, 422, 'Label already exists');
          return true;
        }
        const label: Label = {
          name: labelName,
          color: typeof body.color === 'string' ? body.color : 'ededed',
          description: typeof body.description === 'string' ? body.description : '',
        };
        repo.labels.set(labelName, label);
        sendJson(store, res, 201, labelJson(label));
        return true;
      }
      if (method === 'GET') {
        sendJson(store, res, 200, [...repo.labels.values()].map(labelJson));
        return true;
      }
      return false;
    }

    // /api/v3/repos/{o}/{r}/issues...
    if (rest.length >= 1 && rest[0] === 'issues') {
      return handleIssues(ctx, repo, rest.slice(1), query);
    }

    // /api/v3/repos/{o}/{r}/pulls...
    if (rest.length >= 1 && rest[0] === 'pulls') {
      return handlePulls(ctx, repo, rest.slice(1), query);
    }
  }

  return false;
}

async function handleContents(
  ctx: RestContext,
  repo: Repo,
  pathParts: string[],
  query: URLSearchParams,
): Promise<boolean> {
  const { store, req, res } = ctx;
  const method = req.method ?? 'GET';
  const path = pathParts.join('/');
  const refParam = query.get('ref');
  const branch = refParam !== null && refParam !== '' && !/^[0-9a-f]{40}$/.test(refParam)
    ? refParam
    : repo.defaultBranch;
  const refName = branchRef(branch);

  if (method === 'GET') {
    const tip = repo.refs.get(refName);
    if (tip === undefined) {
      notFound(ctx);
      return true;
    }
    const snapshot = repo.snapshots.get(tip);
    if (snapshot === undefined) {
      notFound(ctx);
      return true;
    }
    if (path === '') {
      // Root directory listing.
      sendJson(store, res, 200, directoryEntries(store, repo, snapshot, ''));
      return true;
    }
    const entry = snapshot.get(path);
    if (entry !== undefined) {
      const object = repo.objects.get(entry.oid);
      if (object === undefined) {
        notFound(ctx);
        return true;
      }
      sendJson(store, res, 200, {
        type: 'file',
        encoding: 'base64',
        content: base64Of(object.data),
        sha: entry.oid,
        size: object.data.length,
        name: path.split('/').pop() ?? path,
        path,
      });
      return true;
    }
    // A directory: any file below this path.
    const prefix = `${path}/`;
    let isDir = false;
    for (const key of snapshot.keys()) {
      if (key.startsWith(prefix)) {
        isDir = true;
        break;
      }
    }
    if (!isDir) {
      notFound(ctx);
      return true;
    }
    sendJson(store, res, 200, directoryEntries(store, repo, snapshot, path));
    return true;
  }

  if (method === 'PUT') {
    const body = await jsonBody(ctx);
    if (body === null) return true;
    const message = typeof body.message === 'string' ? body.message : 'Update file';
    const content = typeof body.content === 'string' ? body.content : '';
    const bytes = base64ToBytes(content);
    if (bytes === null) {
      sendError(store, res, 400, 'Content is not valid base64');
      return true;
    }
    const writeBranch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const writeRef = branchRef(writeBranch);
    const tip = repo.refs.get(writeRef);
    const snapshot = tip !== undefined ? new Map(repo.snapshots.get(tip) ?? new Map()) : new Map();
    const existing = snapshot.get(path);
    const givenSha = typeof body.sha === 'string' ? body.sha : undefined;
    if (givenSha !== undefined) {
      if (existing === undefined || existing.oid.toLowerCase() !== givenSha.toLowerCase()) {
        sendError(store, res, 409, 'sha does not match the current file');
        return true;
      }
    } else if (existing !== undefined) {
      sendError(store, res, 409, 'sha is required to update an existing file');
      return true;
    }
    const blobOid = objectId('blob', bytes);
    store.putObject(repo, 'blob', bytes);
    snapshot.set(path, { oid: blobOid, mode: '100644' });
    const commitOid = commitSnapshot(store, repo, writeBranch, snapshot, message);
    sendJson(store, res, existing === undefined ? 201 : 200, {
      content: { sha: blobOid, encoding: 'base64', name: path.split('/').pop() ?? path, path, size: bytes.length },
      commit: { sha: commitOid },
    });
    return true;
  }

  if (method === 'DELETE') {
    const body = await jsonBody(ctx);
    if (body === null) return true;
    const message = typeof body.message === 'string' ? body.message : 'Delete file';
    const givenSha = typeof body.sha === 'string' ? body.sha : undefined;
    const tip = repo.refs.get(refName);
    if (tip === undefined) {
      notFound(ctx);
      return true;
    }
    const snapshot = new Map(repo.snapshots.get(tip) ?? new Map());
    const existing = snapshot.get(path);
    if (existing === undefined) {
      notFound(ctx);
      return true;
    }
    if (givenSha !== undefined && existing.oid.toLowerCase() !== givenSha.toLowerCase()) {
      sendError(store, res, 409, 'sha does not match the current file');
      return true;
    }
    snapshot.delete(path);
    const commitOid = commitSnapshot(store, repo, branch, snapshot, message);
    sendJson(store, res, 200, { commit: { sha: commitOid } });
    return true;
  }

  return false;
}

/** Immediate children of a directory inside a snapshot. */
function directoryEntries(
  store: Store,
  repo: Repo,
  snapshot: Map<string, { oid: string; mode: string }>,
  dir: string,
): Array<Record<string, unknown>> {
  const prefix = dir === '' ? '' : `${dir}/`;
  const children = new Map<string, { isDir: boolean; oid: string }>();
  for (const [path, entry] of snapshot) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      children.set(rest, { isDir: false, oid: entry.oid });
    } else {
      const name = rest.slice(0, slash);
      if (!children.has(name)) children.set(name, { isDir: true, oid: '' });
    }
  }
  const out: Array<Record<string, unknown>> = [];
  for (const name of [...children.keys()].sort()) {
    const child = children.get(name) as { isDir: boolean; oid: string };
    const childPath = prefix + name;
    if (child.isDir) {
      // The tree id of this directory: rebuild the snapshot trees and walk down.
      const tip = repo.refs.get(branchRef(repo.defaultBranch));
      let treeOid = '';
      if (tip !== undefined) {
        const rootTree = store.commitTree(repo, tip);
        if (rootTree !== null) treeOid = dirTreeOid(store, repo, rootTree, childPath) ?? '';
      }
      out.push({ type: 'dir', name, path: childPath, sha: treeOid });
    } else {
      out.push({ type: 'file', name, path: childPath, sha: child.oid });
    }
  }
  return out;
}

/** The tree id of a directory under a root tree, by walking tree entries. */
function dirTreeOid(store: Store, repo: Repo, rootTree: string, dir: string): string | null {
  void store;
  let current = rootTree;
  for (const part of dir.split('/')) {
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((item) => item.name === part && item.mode === '40000');
    if (entry === undefined) return null;
    current = entry.oid;
  }
  return current;
}

async function handleIssues(
  ctx: RestContext,
  repo: Repo,
  rest: string[],
  query: URLSearchParams,
): Promise<boolean> {
  const { store, req, res } = ctx;
  const method = req.method ?? 'GET';

  if (rest.length === 0) {
    if (method === 'POST') {
      const body = await jsonBody(ctx);
      if (body === null) return true;
      const title = typeof body.title === 'string' ? body.title : '';
      const issueBody = typeof body.body === 'string' ? body.body : '';
      const labelNames: string[] = Array.isArray(body.labels)
        ? body.labels.filter((label): label is string => typeof label === 'string')
        : [];
      const labels: Label[] = [];
      for (const labelName of labelNames) {
        const label = repo.labels.get(labelName);
        if (label === undefined) {
          sendError(store, res, 422, `Label "${labelName}" does not exist`);
          return true;
        }
        labels.push(label);
      }
      repo.numberSeq += 1;
      const at = store.stamp();
      const issue: Issue = {
        id: repo.id * 100000 + repo.numberSeq,
        number: repo.numberSeq,
        title,
        body: issueBody,
        state: 'open',
        labels,
        comments: [],
        createdAt: at,
        updatedAt: at,
        closedAt: null,
      };
      repo.issues.push(issue);
      sendJson(store, res, 201, issueJson(store, repo, issue));
      return true;
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? 'desc';
      let issues = repo.issues.slice();
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      if (sort === 'created') {
        issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      }
      const { page, link } = pageOf(req, issues.map((issue) => issueJson(store, repo, issue)), query);
      sendJson(store, res, 200, page, link !== null ? { link } : {});
      return true;
    }
    return false;
  }

  const number = Number.parseInt(rest[0], 10);
  if (!Number.isSafeInteger(number)) return false;
  const issue = repo.issues.find((item) => item.number === number);
  if (issue === undefined) {
    notFound(ctx);
    return true;
  }

  if (rest.length === 1) {
    if (method === 'GET') {
      sendJson(store, res, 200, issueJson(store, repo, issue));
      return true;
    }
    if (method === 'PATCH') {
      const body = await jsonBody(ctx);
      if (body === null) return true;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (body.state === 'open' || body.state === 'closed') {
        issue.state = body.state;
        issue.closedAt = body.state === 'closed' ? store.stamp() : null;
      }
      issue.updatedAt = store.stamp();
      sendJson(store, res, 200, issueJson(store, repo, issue));
      return true;
    }
    return false;
  }

  if (rest.length === 2 && rest[1] === 'comments') {
    if (method === 'POST') {
      const body = await jsonBody(ctx);
      if (body === null) return true;
      const commentBody = typeof body.body === 'string' ? body.body : '';
      repo.commentSeq += 1;
      const at = store.stamp();
      const comment = {
        id: repo.commentSeq,
        body: commentBody,
        user: store.viewerLogin,
        createdAt: at,
        updatedAt: at,
      };
      issue.comments.push(comment);
      sendJson(store, res, 201, { id: comment.id, body: comment.body, user: { login: comment.user }, created_at: at, updated_at: at });
      return true;
    }
    if (method === 'GET') {
      sendJson(store, res, 200, issue.comments.map((comment) => ({
        id: comment.id,
        body: comment.body,
        user: { login: comment.user },
        created_at: comment.createdAt,
        updated_at: comment.updatedAt,
      })));
      return true;
    }
    return false;
  }

  return false;
}

async function handlePulls(
  ctx: RestContext,
  repo: Repo,
  rest: string[],
  query: URLSearchParams,
): Promise<boolean> {
  const { store, req, res } = ctx;
  const method = req.method ?? 'GET';

  if (rest.length === 0) {
    if (method === 'POST') {
      const body = await jsonBody(ctx);
      if (body === null) return true;
      const headRaw = typeof body.head === 'string' ? body.head : '';
      const baseRaw = typeof body.base === 'string' ? body.base : '';
      const head = headRaw.includes(':') ? headRaw.split(':').pop() as string : headRaw;
      const base = baseRaw.includes(':') ? baseRaw.split(':').pop() as string : baseRaw;
      const title = typeof body.title === 'string' ? body.title : '';
      const pullBody = typeof body.body === 'string' ? body.body : '';
      const headTip = repo.refs.get(branchRef(head));
      const baseTip = repo.refs.get(branchRef(base));
      if (headTip === undefined || baseTip === undefined) {
        sendError(store, res, 422, 'Head or base branch does not exist');
        return true;
      }
      repo.numberSeq += 1;
      const at = store.stamp();
      const pull: Pull = {
        id: repo.id * 100000 + repo.numberSeq,
        number: repo.numberSeq,
        title,
        body: pullBody,
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        mergeable: 'MERGEABLE',
        headRef: head,
        baseRef: base,
        headSha: headTip,
        baseSha: baseTip,
        createdAt: at,
        updatedAt: at,
      };
      pull.mergeable = pullConflicted(store, repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
      repo.pulls.push(pull);
      sendJson(store, res, 201, pullJson(store, repo, pull));
      return true;
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let pulls = repo.pulls.slice();
      if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
      pulls.sort((a, b) => b.number - a.number);
      const { page, link } = pageOf(req, pulls.map((pull) => pullJson(store, repo, pull)), query);
      sendJson(store, res, 200, page, link !== null ? { link } : {});
      return true;
    }
    return false;
  }

  const number = Number.parseInt(rest[0], 10);
  if (!Number.isSafeInteger(number)) return false;
  const pull = repo.pulls.find((item) => item.number === number);

  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    if (pull === undefined) {
      notFound(ctx);
      return true;
    }
    sendJson(store, res, 200, pullFiles(store, repo, pull));
    return true;
  }

  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
    if (pull === undefined) {
      notFound(ctx);
      return true;
    }
    const body = await jsonBody(ctx);
    if (body === null) return true;
    try {
      const merged = mergePull(store, repo, pull);
      sendJson(store, res, 200, { merged: true, sha: merged.sha, message: merged.message });
    } catch (err) {
      if (err instanceof MergeError) {
        sendError(store, res, err.status, err.message);
        return true;
      }
      throw err;
    }
    return true;
  }

  if (rest.length === 1) {
    if (method === 'GET') {
      if (pull === undefined) {
        notFound(ctx);
        return true;
      }
      sendJson(store, res, 200, pullJson(store, repo, pull));
      return true;
    }
    return false;
  }

  return false;
}
