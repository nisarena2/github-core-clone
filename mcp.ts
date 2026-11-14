// MCP over streamable HTTP at /mcp: the 2026-07-28 revision, answered with
// plain JSON bodies (no SSE stream needed — the suite's client reads both).
// server/discover negotiates the modern era; initialize answers the legacy
// handshake too. Six tools, all acting on the same store as REST, so
// anything a tool creates is visible over REST at once.
//
// Auth is decided by app.ts before this handler runs: no bearer token,
// no tools.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { isRecord, parseJsonBody, readBody, sendJson } from './http.ts';
import { MergeError, issueJson, mergePull, pullConflicted, pullJson, repoJson } from './rest.ts';
import { type Issue, type Pull, type Repo, Store } from './store.ts';

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function findRepo(store: Store, args: Record<string, unknown>): Repo {
  const owner = str(args.owner) ?? store.viewerLogin;
  const name = str(args.repo);
  if (name === null) throw new Error('repo is required');
  const repo = store.repo(owner, name);
  if (repo === null) throw new Error(`Repository ${owner}/${name} not found`);
  return repo;
}

function createIssue(store: Store, repo: Repo, title: string, body: string): Issue {
  repo.numberSeq += 1;
  const at = store.stamp();
  const issue: Issue = {
    id: repo.id * 100000 + repo.numberSeq,
    number: repo.numberSeq,
    title,
    body,
    state: 'open',
    labels: [],
    comments: [],
    createdAt: at,
    updatedAt: at,
    closedAt: null,
  };
  repo.issues.push(issue);
  return issue;
}

function createPull(store: Store, repo: Repo, title: string, body: string, head: string, base: string): Pull {
  const headTip = repo.refs.get(`refs/heads/${head}`);
  const baseTip = repo.refs.get(`refs/heads/${base}`);
  if (headTip === undefined || baseTip === undefined) {
    throw new Error('Head or base branch does not exist');
  }
  repo.numberSeq += 1;
  const at = store.stamp();
  const pull: Pull = {
    id: repo.id * 100000 + repo.numberSeq,
    number: repo.numberSeq,
    title,
    body,
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
  return pull;
}

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, Record<string, unknown>>;
  required: string[];
  run: (store: Store, args: Record<string, unknown>) => unknown;
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the token owner.',
    properties: {
      name: { type: 'string', description: 'Repository name' },
      description: { type: 'string', description: 'Repository description' },
      private: { type: 'boolean', description: 'Whether the repository is private' },
      owner: { type: 'string', description: 'Owner login (defaults to the token owner)' },
    },
    required: ['name'],
    run: (store, args) => {
      const name = str(args.name);
      if (name === null) throw new Error('name is required');
      const repo = store.createRepo(name, str(args.description) ?? '', args.private === true);
      if (repo === null) throw new Error(`Repository ${name} already exists`);
      return repoJson(store, repo);
    },
  },
  {
    name: 'get_repo',
    description: 'Read a repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'Owner login' },
      repo: { type: 'string', description: 'Repository name' },
    },
    required: ['owner', 'repo'],
    run: (store, args) => repoJson(store, findRepo(store, args)),
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'Owner login' },
      repo: { type: 'string', description: 'Repository name' },
      title: { type: 'string', description: 'Issue title' },
      body: { type: 'string', description: 'Issue body' },
    },
    required: ['owner', 'repo', 'title'],
    run: (store, args) => {
      const repo = findRepo(store, args);
      const title = str(args.title);
      if (title === null) throw new Error('title is required');
      const issue = createIssue(store, repo, title, str(args.body) ?? '');
      return issueJson(store, repo, issue);
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    properties: {
      owner: { type: 'string', description: 'Owner login' },
      repo: { type: 'string', description: 'Repository name' },
      state: { type: 'string', description: 'Issue state: open, closed or all' },
    },
    required: ['owner', 'repo'],
    run: (store, args) => {
      const repo = findRepo(store, args);
      const state = str(args.state) ?? 'open';
      const issues = state === 'all' ? repo.issues.slice() : repo.issues.filter((issue) => issue.state === state);
      return issues.map((issue) => issueJson(store, repo, issue));
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    properties: {
      owner: { type: 'string', description: 'Owner login' },
      repo: { type: 'string', description: 'Repository name' },
      title: { type: 'string', description: 'Pull request title' },
      body: { type: 'string', description: 'Pull request body' },
      head: { type: 'string', description: 'Head branch name' },
      base: { type: 'string', description: 'Base branch name' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
    run: (store, args) => {
      const repo = findRepo(store, args);
      const title = str(args.title);
      const head = str(args.head);
      const base = str(args.base);
      if (title === null) throw new Error('title is required');
      if (head === null) throw new Error('head is required');
      if (base === null) throw new Error('base is required');
      const pull = createPull(store, repo, title, str(args.body) ?? '', head, base);
      return pullJson(store, repo, pull);
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    properties: {
      owner: { type: 'string', description: 'Owner login' },
      repo: { type: 'string', description: 'Repository name' },
      pull_number: { type: 'integer', description: 'Pull request number' },
    },
    required: ['owner', 'repo', 'pull_number'],
    run: (store, args) => {
      const repo = findRepo(store, args);
      const raw = args.pull_number;
      const number = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
      if (!Number.isSafeInteger(number)) throw new Error('pull_number is required');
      const pull = repo.pulls.find((item) => item.number === number);
      if (pull === undefined) throw new Error(`Pull request #${number} not found`);
      try {
        const merged = mergePull(store, repo, pull);
        return { number: pull.number, merged: true, state: pull.state, sha: merged.sha };
      } catch (err) {
        if (err instanceof MergeError) throw new Error(err.message);
        throw err;
      }
    },
  },
];

function toolList(): Array<Record<string, unknown>> {
  return TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: { type: 'object', properties: tool.properties, required: tool.required },
  }));
}

type RpcResult =
  | { result: unknown }
  | { error: { code: number; message: string } };

function dispatch(store: Store, method: string, params: Record<string, unknown>): RpcResult {
  if (method === 'server/discover') {
    const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
    return {
      result: {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: { listChanged: false } },
        serverInfo,
        _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
      },
    };
  }
  if (method === 'initialize') {
    const protocolVersion = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
    return {
      result: {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      },
    };
  }
  if (method === 'tools/list') {
    return { result: { tools: toolList() } };
  }
  if (method === 'tools/call') {
    const name = params.name;
    const args = isRecord(params.arguments) ? params.arguments : {};
    if (typeof name !== 'string' || name === '') {
      return { error: { code: -32602, message: 'tools/call needs a tool name' } };
    }
    const tool = TOOLS.find((entry) => entry.name === name);
    if (tool === undefined) {
      return { error: { code: -32602, message: `Unknown tool: ${name}` } };
    }
    const missing = tool.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
    if (missing.length > 0) {
      return {
        result: {
          content: [{ type: 'text', text: `missing required argument: ${missing.join(', ')}` }],
          isError: true,
        },
      };
    }
    try {
      const value = tool.run(store, args);
      return {
        result: {
          content: [{ type: 'text', text: JSON.stringify(value) }],
          structuredContent: value,
          isError: false,
        },
      };
    } catch (err) {
      return {
        result: {
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        },
      };
    }
  }
  if (method === 'ping') {
    return { result: {} };
  }
  if (method.startsWith('notifications/')) {
    return { result: {} };
  }
  return { error: { code: -32601, message: `Method not found: ${method}` } };
}

/** POST /mcp. Returns true when the request was handled. */
export async function handleMcp(store: Store, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (req.method === 'DELETE') {
    // A legacy session close; this server hands out no sessions.
    res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' });
    res.end('{"error":"Method not allowed"}\n');
    return true;
  }
  if (req.method !== 'POST') {
    sendJson(store, res, 405, { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'Method not allowed' } });
    return true;
  }
  const raw = await readBody(req);
  const parsed = parseJsonBody(raw);
  if (!parsed.ok) {
    sendJson(store, res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  const body = parsed.value;
  if (!isRecord(body) || typeof body.method !== 'string') {
    const id = isRecord(body) && 'id' in body ? (body.id as string | number | null) : null;
    sendJson(store, res, 400, { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } });
    return true;
  }
  if (!('id' in body)) {
    // A notification (notifications/initialized and friends): acknowledge, no body.
    res.writeHead(202);
    res.end();
    return true;
  }
  const id = body.id as string | number | null;
  const params = isRecord(body.params) ? body.params : {};
  const out = dispatch(store, body.method, params);
  if ('error' in out) {
    sendJson(store, res, 200, { jsonrpc: '2.0', id, error: out.error });
  } else {
    sendJson(store, res, 200, { jsonrpc: '2.0', id, result: out.result });
  }
  return true;
}
