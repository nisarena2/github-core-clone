# Build progress — github-core-clone-01

Deadline: 21 Nov 2026 06:30 UTC. Quota: 0 entries made, can submit.
Score: feature 600 + agent 200 + perf 200 = 1000. Reference forge: 120/120
conformance; T_refs push 1640.82ms / clone 266.941ms / read 2759.715ms / write 348.965ms.

## Phase 0 — rules + kit read (2026-11-15 ~02:20 WITA)
- RULES.txt read in full. Check inventory: git 30, repos 15, issues 15, pulls 20,
  graphql 20, mcp 15, protocol 5 = 120.
- Spec extraction delegated to five parallel readers (git wire, REST, GraphQL, MCP,
  bench/scenario). Repo skeleton created from starter layout (LICENSE, package.json,
  tsconfig.json, README, main.ts lifecycle written fresh).

## Phase 1 — REST v3 core: DONE, verified 2026-11-15 ~02:40 WITA
- `rest.ts` (30,762 B) + `http.ts` + `store.ts`: repos create/list/get/patch/delete,
  contents put/get/delete with sha handling (201/200/409), labels, issues (numbers
  increment by 1 per repo, state/sort/direction filters, comments), pulls (create,
  files, squash merge 200, conflict 405, unknown 404), git/refs, branches, commits
  (`?sha=` filters branch-only commits off the default).
- Protocol: every reply JSON + non-empty `X-GitHub-Request-Id`; errors
  `{message: <string>}`; unknown route 404 JSON; malformed JSON 400; missing bearer
  token 401; root/meta unauthenticated, everything else under /api/v3 needs auth.
- **Battery `/tmp/forge-test/rest.mjs`: 57/57 PASS** (real HTTP against the server).
- Bug fixed during verification: `pullConflicted` used the stale `pull.baseSha`
  (frozen at PR creation) and the bare `pull.baseRef` against full ref keys —
  now resolves the live base tip via `branchRef(pull.baseRef)`.
- Bug fixed before testing: `treeOidAt` / `dirTreeOid` in rest.ts were broken
  stubs (bogus `require()` in ESM, always null). `treeOidAt` deleted;
  `dirTreeOid` rewritten to walk tree entries with the imported `parseTree`.

## Phase 2 — git smart HTTP: DONE, verified 2026-11-15 ~02:40 WITA
- `githttp.ts` (17,413 B) + `git.ts`: info/refs (v2 caps + ls-refs with peel/
  symrefs/unborn/ref-prefix; v0 with caps on the first ref line), upload-pack v2
  (fetch sections acknowledgments/shallow-info/wanted-refs/packfile) and v0
  (two-section request, NAK/ACK, shallow lines, sideband pack), receive-pack v0
  (create/update/delete, fast-forward-only, report-status pkt-lined inside
  sideband band 1, per-ref ok/ng).
- **Battery `/tmp/forge-test/git.mjs` (real git CLI 2.43): 25/25 PASS** —
  empty-repo clone v0+v2, first push, clone after push, incremental push/fetch,
  shallow depth-1 v0+v2, non-fast-forward rejection (plain and --force), branch
  create/delete via push, annotated tag push + peeled advertisement, mixed push
  (one ok + one ng, exit non-zero, good ref applied), REST reads git-pushed
  files (shared store).
- Protocol bugs found by the real git client and fixed (the kit client is
  order-tolerant, real git is not):
  1. v2 fetch: the acknowledgments section exists ONLY when the client sent
     haves; with no haves the reader expects packfile first. Also ends with
     a `ready` line before the delim.
  2. Receive-pack report: the report stream inside band 1 must end with its
     own flush pkt-line, or the reader hits EOF and reports "hung up".
  3. v0 empty-repo advertisement: `<ZERO> capabilities^{}\0<caps>` — the caps
     MUST ride after the NUL or the client sends no capabilities (and then
     expects no report-status).
  4. v0 shallow response: shallow/unshallow lines come BEFORE ACK/NAK, and the
     shallow section ends with a flush.
  5. v0 fetch is TWO POSTs over HTTP: a request without `done` is a
     negotiation-phase request and gets ONLY the shallow list + flush; the
     client re-POSTs with `done` for ACK/NAK + pack.
  6. Pushes record a snapshot from the new tip's tree (`store.ensureSnapshot`)
     so REST contents/issues/pulls see git-pushed files.
- Note: git 2.43 defaults to protocol v2, so the battery forces v0 explicitly
  with `-c protocol.version=0` on the v0-labelled tests.

## Phase 3 — GraphQL: DONE, verified 2026-11-15 ~03:10 WITA
- `graphql.ts` (33,203 B): hand-written tokenizer/parser/executor for exactly the
  subset the suite sends — operations with aliases, variables, inline input
  objects, inline enum lists, null variables, operation names, `... on Type`
  inline fragments, and a JSON array of operation documents in one body
  (batched, answered in order). Same store as REST.
- Types: Query.viewer/repository/node/__type, Mutation createIssue/closeIssue/
  createPullRequest/mergePullRequest/addComment, Repository (id, databaseId,
  name, nameWithOwner, owner, defaultBranchRef, viewerPermission ADMIN,
  hasIssuesEnabled true, issue, issues, pullRequests, pullRequest), Issue,
  PullRequest (state MERGED when merged, mergeable computed live via
  pullConflicted, files via pullFiles), connections with pageInfo + opaque
  base64 cursors, __Type/__Field/__EnumValue introspection (SearchType lists
  ISSUE plus the other five).
- Global ids are opaque base64 of a kind tag + numeric ids
  ("Repository:3", "Issue:3:2"), stable across reads, never the plain
  database id or number. Unknown repository reads data.repository = null with
  no errors; unknown field is HTTP 200 with an errors array naming the field;
  unauthenticated POST is 401 (app.ts, before dispatch).
- Mutations reuse the REST semantics exactly: createIssue/closeIssue write the
  same store records REST reads; createPullRequest validates both branches;
  mergePullRequest calls the shared `mergePull` helper (see rest.ts).
- **Battery `/tmp/forge-test/graphql-mcp.mjs` GraphQL half: 20/20 PASS** and
  the kit's own suite agrees: **graphql 20/20 in grade-local**.

## Phase 4 — MCP: DONE, verified 2026-11-15 ~03:10 WITA
- `mcp.ts` (11,872 B): Streamable HTTP JSON-RPC 2.0 at /mcp, answered with
  plain JSON bodies (the suite client reads JSON or SSE). Modern era first:
  `server/discover` returns supportedVersions 2026-07-28 + the four legacy
  revisions, capabilities.tools, serverInfo (name `forge`, version 1.0.0) in
  both the top level and `_meta['io.modelcontextprotocol/serverInfo']`.
  Legacy `initialize` echoes the offered revision; notifications (no id)
  answer 202 with no body.
- Tools (static list, byte-identical across calls): create_repo, get_repo,
  create_issue, list_issues, create_pull_request, merge_pull_request — all
  acting on the same store as REST (results reuse repoJson/issueJson/pullJson
  so REST parity is exact). tools/call returns content text + structuredContent;
  missing required args answer isError:true; unknown tool answers JSON-RPC
  -32602 (never HTTP 500); a non-JSON body answers HTTP 400 with -32700;
  request ids are echoed exactly (string or number); no bearer token is 401
  (app.ts, before dispatch).
- **Battery `/tmp/forge-test/graphql-mcp.mjs` MCP half: 15/15 PASS** and the
  kit's own suite agrees: **mcp 15/15 in grade-local (agent column 200/200)**.

## Shared change for phases 3–4 (rest.ts)
- `repoJson`, `issueJson`, `pullJson` exported for reuse by GraphQL/MCP.
- Merge core extracted into exported `mergePull(store, repo, pull)` +
  `MergeError` (status + message); the REST PUT merge route now calls it —
  behaviour identical (405 already closed / conflicted / no head content).
- REST battery re-run after the refactor: still **57/57 PASS**.

## Phase 5 — local grading: DONE, 2026-11-15 ~03:2x WITA
- Command: `node cli/makefun.mjs grade-local --kit . --bot <repo-github>
  --driver process --worktree --save /tmp/forge-grade-N` (Docker is not
  installed on this VM, so --driver process; node here is v24.22.1, the
  server's harness runs v22.23.4 — noted by the grader, not a failure).
- Kit quirk fixed first: the shipped practice/trial-{0,1,2} lack
  `input/env/`, so grade-local voided the trial ("no input/env/ for the env
  to read its seed from"). The kit's own generator creates exactly that
  empty directory when drawing an instance, and the instance manifest only
  lists files, so creating the three empty dirs does not change the instance
  sha256 (the digest check still passed). Fix is in the local kit copy only.
- **Grade run 2 (/tmp/forge-grade-2): 924/1000** — agent 200, feature 590
  (118/120), perf 134. The 2 failures were both git shallow-fetch checks.
- **Shallow bug found and fixed (git.ts `objectsForFetch`)**: the pack
  builder walked the FULL history from every included commit
  (`collectReachable`), so a depth-1 clone carried all 3 commits, and a
  deepen-2 fetch emptied itself (the haves subtraction removed the parent
  it had just collected). Fix: two bounded walks — `collectBounded` for the
  haves (stops below the client's declared shallow boundaries, so a shallow
  commit's parents are not treated as held) and `collectIncluded` for the
  pack (follows parents only while they are themselves included). Both
  call sites in githttp.ts (v0 + v2) now pass `fetch.shallow`.
  New battery `/tmp/forge-test/shallow.mjs`: **10/10 PASS** (depth-1 clone
  v0+v2 delivers exactly 1 commit + tip tree/blobs, shallow file names the
  tip; deepen 2 delivers exactly 2 commits and moves the boundary).
- **Grade run 3 (/tmp/forge-grade-3): 957/1000** — agent 200, feature **600
  (120/120)**, perf 157 (clone 34, push 33, read 45, write 45).
- **Grade run 4 (/tmp/forge-grade-4): 975/1000** — agent 200, feature **600
  (120/120)**, perf 175 (clone 44, push 36, read 50, write 45).
  Conformance is stable at 120/120 across runs; perf moves run to run
  (157→175) on this shared VM, so treat the perf column as noisy locally.
  Both runs: live pass finished in ~13 s, exit 0, replay matched
  byte-for-byte, L1 regrade reproduced byte-for-byte, working 1/1.
- Per-group (both runs): git 30/30, graphql 20/20, issues 15/15, mcp 15/15,
  protocol 5/5, pulls 20/20, repos 15/15.
- Perf reference times (house): push 1640.82ms / clone 266.941ms /
  read 2759.715ms / write 348.965ms. Local p50s (run 4): push 877.6ms,
  clone 94.2ms, read 694.8ms, write 114.2ms — all four beat the reference
  medians locally, but the server grades in its own sandbox, so the local
  perf column is indicative only.
- Eligibility note from the grader: `eligible ranked yes, prize no,
  efficiency no (no_transcripts, coverage_below_gate, cost_unpriced)` —
  expected for a local grade with no transcripts/bundle; the parent's
  bundle + submit step is what makes it submittable. No submission made,
  no GitHub repo created (parent handles that).

## Files
- `main.ts` lifecycle (bind ephemeral port, register, poll /done, exit 0).
- `app.ts` routing: /healthz, /{owner}/{repo}.git, /api/v3 (auth except
  root/meta), /api/graphql (graphql.ts), /mcp (mcp.ts), else 404 JSON.
- `store.ts` in-memory store + deterministic logical clock + RNG/scenario
  (viewer `adaiversen` derived from the fixed seed, never hardcoded).
- Test batteries live in `/tmp/forge-test/` (rest.mjs 57/57, git.mjs 25/25,
  graphql-mcp.mjs 46/46, shallow.mjs 10/10, debug-*.mjs). Local grades kept
  in /tmp/forge-grade-2/3/4 (best: run 4, 975/1000, 120/120).
- No submission made, no GitHub repo created (parent handles that).
