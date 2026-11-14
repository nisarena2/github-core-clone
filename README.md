# Forge

A standalone GitHub-compatible git forge in one Node process. It serves its own
store with no UI and no outside service:

- git smart HTTP at `/<owner>/<repo>.git` — upload-pack protocol v2 and
  receive-pack v0 for clone, fetch and push
- REST v3 under `/api/v3` — repositories, branches, commits, contents, issues,
  comments, labels, pull requests, files and merges
- GraphQL v4 at `/api/graphql`
- Model Context Protocol at `/mcp` over streamable HTTP

## Run it

```sh
node --experimental-strip-types main.ts
```

The program binds an ephemeral port, registers it with the env at
`$MAKEFUN_ENV_URL`, and exits 0 once the env reports the trial done. Node 22
only, standard library only, no install step.

## Layout

- `main.ts` — the entry lifecycle: bind, register, wait for done.
- `app.ts` — the HTTP server and every surface above.
- `store.ts` — the in-memory store: repositories, git objects, issues, pull
  requests, labels and comments.
- `git.ts` — the git object model and the smart-HTTP pack protocol.
- `graphql.ts` — the GraphQL v4 documents.
- `mcp.ts` — the MCP tools.

## Progress

See `PROGRESS.md` for the per-phase build and verification log.
