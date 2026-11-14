// GraphQL v4 surface under /api/graphql: the documents gh and
// github-mcp-server actually send — viewer, repository fields, the
// __type feature probes, issue and pull-request reads, the create/close/
// merge mutations, node(id:), cursor pagination, and two operation
// documents in one body. A small hand-written parser and executor for
// exactly that subset; the same store as REST, so every mutation is
// visible over REST at once.
//
// Global ids are opaque base64 of a kind tag plus the numeric ids
// ("Repository:3", "Issue:3:2"), stable across reads and never the plain
// database id or number.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { isRecord, parseJsonBody, readBody, sendJson } from './http.ts';
import { MergeError, mergePull, pullConflicted, pullFiles } from './rest.ts';
import { type Issue, type Pull, type Repo, Store } from './store.ts';

// ---------------------------------------------------------------------------
// Global ids
// ---------------------------------------------------------------------------

function gid(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from([kind, ...parts.map(String)].join(':'), 'utf8').toString('base64');
}

function ungid(id: unknown): { kind: string; parts: string[] } | null {
  if (typeof id !== 'string' || id === '') return null;
  const raw = Buffer.from(id, 'base64').toString('utf8');
  const parts = raw.split(':');
  if (parts.length < 2 || parts[0] === '') return null;
  return { kind: parts[0] as string, parts: parts.slice(1) };
}

function repoFromGlobalId(store: Store, id: unknown): Repo | null {
  const decoded = ungid(id);
  if (decoded === null || decoded.kind !== 'Repository') return null;
  const numeric = Number(decoded.parts[0]);
  if (!Number.isSafeInteger(numeric)) return null;
  return store.listRepos().find((repo) => repo.id === numeric) ?? null;
}

function issueFromGlobalId(store: Store, id: unknown): { repo: Repo; issue: Issue } | null {
  const decoded = ungid(id);
  if (decoded === null || decoded.kind !== 'Issue' || decoded.parts.length < 2) return null;
  const repo = repoFromGlobalId(store, gid('Repository', decoded.parts[0] as string));
  if (repo === null) return null;
  const number = Number(decoded.parts[1]);
  const issue = repo.issues.find((item) => item.number === number);
  return issue === undefined ? null : { repo, issue };
}

function pullFromGlobalId(store: Store, id: unknown): { repo: Repo; pull: Pull } | null {
  const decoded = ungid(id);
  if (decoded === null || decoded.kind !== 'PullRequest' || decoded.parts.length < 2) return null;
  const repo = repoFromGlobalId(store, gid('Repository', decoded.parts[0] as string));
  if (repo === null) return null;
  const number = Number(decoded.parts[1]);
  const pull = repo.pulls.find((item) => item.number === number);
  return pull === undefined ? null : { repo, pull };
}

// ---------------------------------------------------------------------------
// Document parsing
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread'; value: string }
  | { kind: 'var'; value: string };

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && text.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if (ch === '$') {
      let j = i + 1;
      while (j < text.length && /[_0-9A-Za-z]/.test(text[j] as string)) j += 1;
      if (j === i + 1) throw new Error('Expected a variable name after $');
      tokens.push({ kind: 'var', value: text.slice(i + 1, j) });
      i = j;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\') {
          const esc = text[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === 'b') out += '\b';
          else if (esc === 'f') out += '\f';
          else if (esc === '/') out += '/';
          else if (esc === '\\') out += '\\';
          else if (esc === '"') out += '"';
          else if (esc === 'u') {
            out += String.fromCharCode(Number.parseInt(text.slice(j + 2, j + 6), 16));
            j += 4;
          } else if (esc !== undefined) out += esc;
          j += 2;
          continue;
        }
        out += text[j];
        j += 1;
      }
      if (j >= text.length) throw new Error('Unterminated string in document');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(text[i + 1] ?? ''))) {
      let j = i;
      if (text[j] === '-') j += 1;
      while (j < text.length && /[0-9]/.test(text[j] as string)) j += 1;
      let isFloat = false;
      if (text[j] === '.' && /[0-9]/.test(text[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < text.length && /[0-9]/.test(text[j] as string)) j += 1;
      }
      if (text[j] === 'e' || text[j] === 'E') {
        isFloat = true;
        j += 1;
        if (text[j] === '+' || text[j] === '-') j += 1;
        while (j < text.length && /[0-9]/.test(text[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: text.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < text.length && /[_0-9A-Za-z]/.test(text[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: text.slice(i, j) });
      i = j;
      continue;
    }
    if ('!()[]{}:=@|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(ch)} in document`);
  }
  return tokens;
}

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

interface FieldNode {
  /** '' for an inline fragment; its type is inlineType. */
  name: string;
  alias: string | null;
  args: Record<string, ValueNode>;
  selections: FieldNode[] | null;
  inlineType: string | null;
}

interface OperationNode {
  kind: 'query' | 'mutation';
  name: string | null;
  defaults: Record<string, ValueNode>;
  selections: FieldNode[];
}

class Parser {
  readonly #tokens: Token[];
  #pos = 0;

  constructor(tokens: Token[]) {
    this.#tokens = tokens;
  }

  #peek(): Token | null {
    return this.#tokens[this.#pos] ?? null;
  }

  #next(): Token {
    const token = this.#tokens[this.#pos];
    if (token === undefined) throw new Error('Unexpected end of document');
    this.#pos += 1;
    return token;
  }

  #isPunct(value: string): boolean {
    const token = this.#peek();
    return token !== null && token.kind === 'punct' && token.value === value;
  }

  #eatPunct(value: string): boolean {
    if (!this.#isPunct(value)) return false;
    this.#pos += 1;
    return true;
  }

  #expectPunct(value: string): void {
    if (!this.#eatPunct(value)) throw new Error(`Expected "${value}" in document`);
  }

  #expectName(expected?: string): string {
    const token = this.#next();
    if (token.kind !== 'name') throw new Error('Expected a name in document');
    if (expected !== undefined && token.value !== expected) throw new Error(`Expected "${expected}" in document`);
    return token.value;
  }

  parseDocument(): OperationNode[] {
    const operations: OperationNode[] = [];
    while (this.#peek() !== null) {
      operations.push(this.#parseOperation());
    }
    if (operations.length === 0) throw new Error('Document holds no operation');
    return operations;
  }

  #parseOperation(): OperationNode {
    const token = this.#peek();
    if (token !== null && token.kind === 'punct' && token.value === '{') {
      return { kind: 'query', name: null, defaults: {}, selections: this.#parseSelectionSet() };
    }
    const keyword = this.#expectName();
    if (keyword === 'fragment') throw new Error('Named fragments are not supported');
    if (keyword !== 'query' && keyword !== 'mutation') throw new Error(`Unknown operation "${keyword}"`);
    let name: string | null = null;
    const next = this.#peek();
    if (next !== null && next.kind === 'name') name = this.#next().value;
    const defaults = this.#isPunct('(') ? this.#parseVariableDefinitions() : {};
    this.#skipDirectives();
    return { kind: keyword, name, defaults, selections: this.#parseSelectionSet() };
  }

  #parseVariableDefinitions(): Record<string, ValueNode> {
    const defaults: Record<string, ValueNode> = {};
    this.#expectPunct('(');
    while (!this.#isPunct(')')) {
      const varToken = this.#next();
      if (varToken.kind !== 'var') throw new Error('Expected a variable in definitions');
      this.#expectPunct(':');
      this.#skipType();
      if (this.#eatPunct('=')) defaults[varToken.value] = this.#parseValue();
    }
    this.#expectPunct(')');
    return defaults;
  }

  #skipType(): void {
    if (this.#eatPunct('[')) {
      this.#skipType();
      this.#expectPunct(']');
    } else {
      this.#expectName();
    }
    this.#eatPunct('!');
  }

  #skipDirectives(): void {
    while (this.#isPunct('@')) {
      this.#next();
      this.#expectName();
      if (this.#isPunct('(')) this.#parseArguments();
    }
  }

  #parseSelectionSet(): FieldNode[] {
    this.#expectPunct('{');
    const fields: FieldNode[] = [];
    while (!this.#isPunct('}')) {
      if (this.#peek() === null) throw new Error('Unterminated selection set');
      fields.push(this.#parseField());
    }
    this.#expectPunct('}');
    return fields;
  }

  #parseField(): FieldNode {
    const token = this.#peek();
    if (token !== null && token.kind === 'spread') {
      this.#next();
      const next = this.#peek();
      if (next !== null && next.kind === 'name' && next.value === 'on') {
        this.#next();
        const typeName = this.#expectName();
        this.#skipDirectives();
        return { name: '', alias: null, args: {}, selections: this.#parseSelectionSet(), inlineType: typeName };
      }
      throw new Error('Named fragment spreads are not supported');
    }
    let name = this.#expectName();
    let alias: string | null = null;
    if (this.#isPunct(':')) {
      this.#next();
      alias = name;
      name = this.#expectName();
    }
    const args = this.#isPunct('(') ? this.#parseArguments() : {};
    this.#skipDirectives();
    const selections = this.#isPunct('{') ? this.#parseSelectionSet() : null;
    return { name, alias, args, selections, inlineType: null };
  }

  #parseArguments(): Record<string, ValueNode> {
    const args: Record<string, ValueNode> = {};
    this.#expectPunct('(');
    while (!this.#isPunct(')')) {
      const name = this.#expectName();
      this.#expectPunct(':');
      args[name] = this.#parseValue();
    }
    this.#expectPunct(')');
    return args;
  }

  #parseValue(): ValueNode {
    const token = this.#next();
    if (token.kind === 'var') return { kind: 'variable', name: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (!(this.#peek() !== null && this.#peek()?.kind === 'punct' && this.#peek()?.value === ']')) {
        items.push(this.#parseValue());
      }
      this.#expectPunct(']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Record<string, ValueNode> = {};
      while (!(this.#peek() !== null && this.#peek()?.kind === 'punct' && this.#peek()?.value === '}')) {
        const name = this.#expectName();
        this.#expectPunct(':');
        fields[name] = this.#parseValue();
      }
      this.#expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`Unexpected value token ${token.kind} ${token.value}`);
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>, defaults: Record<string, ValueNode>): unknown {
  switch (node.kind) {
    case 'variable': {
      if (node.name in variables) return variables[node.name];
      const fallback = defaults[node.name];
      return fallback === undefined ? null : resolveValue(fallback, variables, defaults);
    }
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.items.map((item) => resolveValue(item, variables, defaults));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.fields)) out[key] = resolveValue(value, variables, defaults);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// Schema tables (what __type reports)
// ---------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest',
  ],
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo'],
  PullRequestChangedFile: ['path'],
  PageInfo: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'],
  Ref: ['name'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description'],
  __EnumValue: ['name', 'description'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

class GqlError extends Error {}

type Wrapped = Record<string, unknown> & { __typename: string };

function wrapRepo(repo: Repo): Wrapped {
  return { __typename: 'Repository', repo };
}

function wrapIssue(repo: Repo, issue: Issue): Wrapped {
  return { __typename: 'Issue', repo, issue };
}

function wrapPull(repo: Repo, pull: Pull): Wrapped {
  return { __typename: 'PullRequest', repo, pull };
}

function asRepo(obj: Wrapped): Repo {
  return obj.repo as Repo;
}

function asIssue(obj: Wrapped): Issue {
  return obj.issue as Issue;
}

function asPull(obj: Wrapped): Pull {
  return obj.pull as Pull;
}

type Resolver = (obj: Wrapped, args: Record<string, unknown>, ctx: Executor) => unknown;

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: (_obj, _args, ctx) => ({ __typename: 'User', login: ctx.store.viewerLogin }),
    repository: (_obj, args, ctx) => {
      const repo = ctx.store.repo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo === null ? null : wrapRepo(repo);
    },
    node: (_obj, args, ctx) => {
      const decoded = ungid(args.id);
      if (decoded === null) return null;
      if (decoded.kind === 'Repository') {
        const repo = repoFromGlobalId(ctx.store, args.id);
        return repo === null ? null : wrapRepo(repo);
      }
      if (decoded.kind === 'Issue') {
        const found = issueFromGlobalId(ctx.store, args.id);
        return found === null ? null : wrapIssue(found.repo, found.issue);
      }
      if (decoded.kind === 'PullRequest') {
        const found = pullFromGlobalId(ctx.store, args.id);
        return found === null ? null : wrapPull(found.repo, found.pull);
      }
      return null;
    },
    __type: (_obj, args) => {
      const name = String(args.name ?? '');
      if (name in TYPE_FIELDS) {
        return {
          __typename: '__Type',
          name,
          kind: 'OBJECT',
          fields: (TYPE_FIELDS[name] as string[]).map((field) => ({ __typename: '__Field', name: field })),
          enumValues: [],
          description: null,
        };
      }
      if (name in ENUM_VALUES) {
        return {
          __typename: '__Type',
          name,
          kind: 'ENUM',
          fields: [],
          enumValues: (ENUM_VALUES[name] as string[]).map((value) => ({ __typename: '__EnumValue', name: value })),
          description: null,
        };
      }
      return null;
    },
  },
  Mutation: {
    createIssue: (_obj, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = repoFromGlobalId(ctx.store, input.repositoryId);
      if (repo === null) throw new GqlError('createIssue: repository not found');
      const title = typeof input.title === 'string' ? input.title : '';
      const body = typeof input.body === 'string' ? input.body : '';
      repo.numberSeq += 1;
      const at = ctx.store.stamp();
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
      return { __typename: 'CreateIssuePayload', issue: wrapIssue(repo, issue) };
    },
    closeIssue: (_obj, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = issueFromGlobalId(ctx.store, input.issueId);
      if (found === null) throw new GqlError('closeIssue: issue not found');
      found.issue.state = 'closed';
      found.issue.closedAt = ctx.store.stamp();
      found.issue.updatedAt = found.issue.closedAt;
      return { __typename: 'CloseIssuePayload', issue: wrapIssue(found.repo, found.issue) };
    },
    createPullRequest: (_obj, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = repoFromGlobalId(ctx.store, input.repositoryId);
      if (repo === null) throw new GqlError('createPullRequest: repository not found');
      const head = typeof input.headRefName === 'string' ? input.headRefName : '';
      const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      const title = typeof input.title === 'string' ? input.title : '';
      const headTip = repo.refs.get(`refs/heads/${head}`);
      const baseTip = repo.refs.get(`refs/heads/${base}`);
      if (headTip === undefined || baseTip === undefined) {
        throw new GqlError('createPullRequest: head or base branch does not exist');
      }
      repo.numberSeq += 1;
      const at = ctx.store.stamp();
      const pull: Pull = {
        id: repo.id * 100000 + repo.numberSeq,
        number: repo.numberSeq,
        title,
        body: '',
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
      pull.mergeable = pullConflicted(ctx.store, repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
      repo.pulls.push(pull);
      return { __typename: 'CreatePullRequestPayload', pullRequest: wrapPull(repo, pull) };
    },
    mergePullRequest: (_obj, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = pullFromGlobalId(ctx.store, input.pullRequestId);
      if (found === null) throw new GqlError('mergePullRequest: pull request not found');
      try {
        mergePull(ctx.store, found.repo, found.pull);
      } catch (err) {
        if (err instanceof MergeError) throw new GqlError(`mergePullRequest: ${err.message}`);
        throw err;
      }
      return { __typename: 'MergePullRequestPayload', pullRequest: wrapPull(found.repo, found.pull) };
    },
    addComment: (_obj, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = issueFromGlobalId(ctx.store, input.subjectId);
      if (found === null) throw new GqlError('addComment: issue not found');
      const body = typeof input.body === 'string' ? input.body : '';
      found.repo.commentSeq += 1;
      const at = ctx.store.stamp();
      const comment = {
        id: found.repo.commentSeq,
        body,
        user: ctx.store.viewerLogin,
        createdAt: at,
        updatedAt: at,
      };
      found.issue.comments.push(comment);
      return {
        __typename: 'AddCommentPayload',
        commentEdge: {
          __typename: 'IssueCommentEdge',
          node: {
            __typename: 'IssueComment',
            id: gid('IssueComment', found.repo.id, found.issue.number, comment.id),
            body: comment.body,
          },
        },
      };
    },
  },
  User: {
    id: (obj, _args, ctx) => gid('User', String(obj.login ?? ctx.store.viewerLogin)),
    login: (obj) => String(obj.login ?? ''),
  },
  Repository: {
    id: (obj) => gid('Repository', asRepo(obj).id),
    databaseId: (obj) => asRepo(obj).id,
    name: (obj) => asRepo(obj).name,
    nameWithOwner: (obj) => `${asRepo(obj).owner}/${asRepo(obj).name}`,
    owner: (obj) => ({ __typename: 'User', login: asRepo(obj).owner }),
    defaultBranchRef: (obj) => ({ __typename: 'Ref', name: asRepo(obj).defaultBranch }),
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    issue: (obj, args) => {
      const repo = asRepo(obj);
      const number = Number(args.number);
      const issue = repo.issues.find((item) => item.number === number);
      return issue === undefined ? null : wrapIssue(repo, issue);
    },
    issues: (obj, args, ctx) => ctx.issueConnection(asRepo(obj), args),
    pullRequests: (obj, args, ctx) => ctx.pullConnection(asRepo(obj), args),
    pullRequest: (obj, args) => {
      const repo = asRepo(obj);
      const number = Number(args.number);
      const pull = repo.pulls.find((item) => item.number === number);
      return pull === undefined ? null : wrapPull(repo, pull);
    },
  },
  Issue: {
    id: (obj) => gid('Issue', asRepo(obj).id, asIssue(obj).number),
    number: (obj) => asIssue(obj).number,
    title: (obj) => asIssue(obj).title,
    state: (obj) => (asIssue(obj).state === 'open' ? 'OPEN' : 'CLOSED'),
    body: (obj) => asIssue(obj).body,
  },
  PullRequest: {
    id: (obj) => gid('PullRequest', asRepo(obj).id, asPull(obj).number),
    number: (obj) => asPull(obj).number,
    state: (obj) => {
      const pull = asPull(obj);
      if (pull.merged) return 'MERGED';
      return pull.state === 'open' ? 'OPEN' : 'CLOSED';
    },
    merged: (obj) => asPull(obj).merged,
    headRefName: (obj) => asPull(obj).headRef,
    baseRefName: (obj) => asPull(obj).baseRef,
    mergeable: (obj, _args, ctx) => (pullConflicted(ctx.store, asRepo(obj), asPull(obj)) ? 'CONFLICTING' : 'MERGEABLE'),
    files: (obj, args, ctx) => {
      const repo = asRepo(obj);
      const pull = asPull(obj);
      const first = typeof args.first === 'number' ? args.first : 10;
      const nodes = pullFiles(ctx.store, repo, pull)
        .slice(0, Math.max(0, first))
        .map((file) => ({ __typename: 'PullRequestChangedFile', path: String(file.filename ?? '') }));
      return {
        __typename: 'PullRequestChangedFileConnection',
        nodes,
        pageInfo: { __typename: 'PageInfo', hasNextPage: false, endCursor: null, hasPreviousPage: false, startCursor: null },
      };
    },
  },
};

class Executor {
  readonly store: Store;
  readonly errors: Array<{ message: string }> = [];

  constructor(store: Store) {
    this.store = store;
  }

  execute(operation: OperationNode, variables: Record<string, unknown>): Record<string, unknown> {
    if (operation.kind === 'query') {
      return this.executeSelections('Query', { __typename: 'Query' }, operation.selections, operation.defaults, variables);
    }
    return this.executeSelections('Mutation', { __typename: 'Mutation' }, operation.selections, operation.defaults, variables);
  }

  issueConnection(repo: Repo, args: Record<string, unknown>): Wrapped {
    let issues = repo.issues.slice();
    const states = args.states;
    if (Array.isArray(states) && states.length > 0) {
      const wanted = new Set(states.map((state) => (state === 'OPEN' ? 'open' : 'closed')));
      issues = issues.filter((issue) => wanted.has(issue.state));
    }
    const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
    const direction = orderBy.direction === 'ASC' ? 1 : -1;
    issues.sort((a, b) => (a.number - b.number) * direction);
    return this.paginate(
      'IssueConnection',
      issues.map((issue) => wrapIssue(repo, issue)),
      issues.map((issue) => issue.number),
      args,
    );
  }

  pullConnection(repo: Repo, args: Record<string, unknown>): Wrapped {
    const pulls = repo.pulls.filter((pull) => pull.state === 'open').sort((a, b) => b.number - a.number);
    return this.paginate(
      'PullRequestConnection',
      pulls.map((pull) => wrapPull(repo, pull)),
      pulls.map((pull) => pull.number),
      args,
    );
  }

  private paginate(typeName: string, nodes: Wrapped[], keys: number[], args: Record<string, unknown>): Wrapped {
    let start = 0;
    if (typeof args.after === 'string' && args.after !== '') {
      const decoded = ungid(args.after);
      if (decoded !== null && decoded.kind === 'cursor') {
        const index = keys.indexOf(Number(decoded.parts[0]));
        if (index >= 0) start = index + 1;
      }
    }
    const first = typeof args.first === 'number' ? Math.max(0, args.first) : 30;
    const page = nodes.slice(start, start + first);
    const pageKeys = keys.slice(start, start + first);
    const hasNextPage = start + first < nodes.length;
    const endCursor = pageKeys.length === 0 ? null : gid('cursor', pageKeys[pageKeys.length - 1] as number);
    return {
      __typename: typeName,
      nodes: page,
      pageInfo: {
        __typename: 'PageInfo',
        hasNextPage,
        endCursor,
        hasPreviousPage: start > 0,
        startCursor: pageKeys.length === 0 ? null : gid('cursor', pageKeys[0] as number),
      },
      totalCount: nodes.length,
    };
  }

  private executeSelections(
    typeName: string,
    obj: Wrapped,
    selections: FieldNode[],
    defaults: Record<string, ValueNode>,
    variables: Record<string, unknown>,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const field of selections) {
      if (field.name === '') {
        // Inline fragment: include only when the type matches.
        if (field.inlineType === null || obj.__typename === field.inlineType) {
          Object.assign(result, this.executeSelections(typeName, obj, field.selections ?? [], defaults, variables));
        }
        continue;
      }
      const key = field.alias ?? field.name;
      try {
        const args: Record<string, unknown> = {};
        for (const [name, node] of Object.entries(field.args)) {
          args[name] = resolveValue(node, variables, defaults);
        }
        let value = this.resolveField(typeName, obj, field.name, args);
        if (field.selections !== null && value !== null && value !== undefined) {
          value = this.executeValue(value, field.selections, defaults, variables);
        }
        result[key] = value;
      } catch (err) {
        this.errors.push({ message: err instanceof Error ? err.message : String(err) });
        result[key] = null;
      }
    }
    return result;
  }

  private executeValue(
    value: unknown,
    selections: FieldNode[],
    defaults: Record<string, ValueNode>,
    variables: Record<string, unknown>,
  ): unknown {
    if (Array.isArray(value)) {
      return value.map((entry) => (entry === null ? null : this.executeValue(entry, selections, defaults, variables)));
    }
    if (isRecord(value) && typeof value.__typename === 'string') {
      return this.executeSelections(value.__typename, value as Wrapped, selections, defaults, variables);
    }
    if (isRecord(value)) {
      // A plain record (a mutation payload, a pageInfo): resolve its keys directly.
      const out: Record<string, unknown> = {};
      for (const field of selections) {
        if (field.name === '') continue;
        const key = field.alias ?? field.name;
        if (!(field.name in value)) {
          this.errors.push({ message: `Cannot query field "${field.name}" on an object value.` });
          out[key] = null;
          continue;
        }
        let entry = value[field.name];
        if (field.selections !== null && entry !== null && entry !== undefined) {
          entry = this.executeValue(entry, field.selections, defaults, variables);
        }
        out[key] = entry;
      }
      return out;
    }
    throw new GqlError('A field with sub-selections resolved to a scalar value.');
  }

  private resolveField(typeName: string, obj: Wrapped, name: string, args: Record<string, unknown>): unknown {
    if (name === '__typename') return typeName;
    const resolver = RESOLVERS[typeName]?.[name];
    if (resolver !== undefined) return resolver(obj, args, this);
    if (isRecord(obj) && name in obj) return obj[name];
    throw new GqlError(`Cannot query field "${name}" on type "${typeName}".`);
  }
}

function executeRequest(store: Store, body: unknown): Record<string, unknown> {
  if (!isRecord(body) || typeof body.query !== 'string') {
    return { data: null, errors: [{ message: 'Request body must be a JSON object with a query string' }] };
  }
  const variables = isRecord(body.variables) ? (body.variables as Record<string, unknown>) : {};
  try {
    const operations = new Parser(tokenize(body.query)).parseDocument();
    let operation: OperationNode | null = null;
    if (typeof body.operationName === 'string' && body.operationName !== '') {
      operation = operations.find((entry) => entry.name === body.operationName) ?? null;
    } else {
      operation = operations[0] ?? null;
    }
    if (operation === null) return { data: null, errors: [{ message: 'No operation to execute' }] };
    const executor = new Executor(store);
    const data = executor.execute(operation, variables);
    const out: Record<string, unknown> = { data };
    if (executor.errors.length > 0) out.errors = executor.errors;
    return out;
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
}

/** POST /api/graphql. Returns true when the request was handled. */
export async function handleGraphQL(store: Store, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (req.method !== 'POST') {
    sendJson(store, res, 405, { errors: [{ message: 'GraphQL requires POST' }] });
    return true;
  }
  const raw = await readBody(req);
  const parsed = parseJsonBody(raw);
  if (!parsed.ok) {
    sendJson(store, res, 400, { errors: [{ message: 'Request body is not valid JSON' }] });
    return true;
  }
  if (Array.isArray(parsed.value)) {
    sendJson(store, res, 200, parsed.value.map((entry) => executeRequest(store, entry)));
    return true;
  }
  sendJson(store, res, 200, executeRequest(store, parsed.value));
  return true;
}
