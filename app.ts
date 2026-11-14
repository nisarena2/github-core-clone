// The server: one process, five surfaces, one store.
//
//   GET  /healthz                 the env's boot probe, no auth
//   /{owner}/{repo}.git/...       git smart HTTP (no auth: the protocol is the check)
//   /api/v3/...                   REST v3 (bearer auth, except the root and meta)
//   POST /api/graphql             GraphQL v4 (bearer auth)
//   POST /mcp                     MCP over streamable HTTP (bearer auth)
//   anything else                 404 {"message":"Not Found"}, never HTML

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGit } from './githttp.ts';
import { handleGraphQL } from './graphql.ts';
import { authorized, pathSegments, sendError, sendJson } from './http.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { Store } from './store.ts';

export function createApp(): Server {
  const store = new Store();

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const method = req.method ?? 'GET';
        const segments = pathSegments(req);

        // The env's boot probe: 200 {"ok":true}, twice, no auth.
        if (method === 'GET' && segments.length === 1 && segments[0] === 'healthz') {
          sendJson(store, res, 200, { ok: true });
          return;
        }

        // Git smart HTTP.
        if (segments.length >= 2 && segments[1].endsWith('.git')) {
          const handled = await handleGit(store, req, res);
          if (handled) return;
        }

        // REST v3.
        if (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3') {
          const isRoot = method === 'GET' && segments.length === 2;
          const isMeta = method === 'GET' && segments.length === 3 && segments[2] === 'meta';
          if (!isRoot && !isMeta && !authorized(req)) {
            sendError(store, res, 401, 'Requires authentication');
            return;
          }
          const handled = await handleRest({ store, req, res });
          if (handled) return;
          sendError(store, res, 404, 'Not Found');
          return;
        }

        // GraphQL v4 (graphql.ts).
        if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
          if (!authorized(req)) {
            sendError(store, res, 401, 'Requires authentication');
            return;
          }
          const handled = await handleGraphQL(store, req, res);
          if (handled) return;
          sendError(store, res, 404, 'Not Found');
          return;
        }

        // MCP over streamable HTTP (mcp.ts).
        if (segments.length === 1 && segments[0] === 'mcp') {
          if (!authorized(req)) {
            sendError(store, res, 401, 'Requires authentication');
            return;
          }
          const handled = await handleMcp(store, req, res);
          if (handled) return;
          sendError(store, res, 404, 'Not Found');
          return;
        }

        // Everything else: GitHub's 404 body.
        sendError(store, res, 404, 'Not Found');
      } catch (err) {
        // A handler must never take the server down with it.
        try {
          sendError(store, res, 500, err instanceof Error ? err.message : 'Internal Server Error');
        } catch {
          // The response is already gone; nothing left to do.
        }
      }
    })();
  });
}
