// Small HTTP helpers shared by every surface: JSON replies, bodies, auth and
// pagination. Every REST reply is application/json, never HTML, and carries a
// non-empty X-GitHub-Request-Id.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store } from './store.ts';

export const JSON_TYPE = 'application/json; charset=utf-8';

export function sendJson(
  store: Store,
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': store.nextRequestId(),
    ...headers,
  });
  res.end(text);
}

export function sendError(store: Store, res: ServerResponse, status: number, message: string): void {
  sendJson(store, res, status, { message });
}

/** Read a request body fully; rejects past the limit. */
export function readBody(req: IncomingMessage, limitBytes = 1_048_576): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a JSON body: {} for an empty body, a 400 marker for malformed JSON. */
export function parseJsonBody(raw: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (raw.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The bearer token this process was given, or '' when none was. */
export function envToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

/** True when the request carries the trial's bearer token (or no token is configured). */
export function authorized(req: IncomingMessage): boolean {
  const token = envToken();
  if (token === '') return true;
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${token}`;
}

/** The path segments of a request URL, decoded, without empty parts. */
export function pathSegments(req: IncomingMessage): string[] {
  try {
    const url = new URL(req.url ?? '/', 'http://forge');
    return url.pathname.split('/').filter((part) => part !== '').map((part) => decodeURIComponent(part));
  } catch {
    return [];
  }
}

export function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://forge').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** A page of items, with a Link header naming the next page when there is one. */
export function pageOf<T>(
  req: IncomingMessage,
  items: T[],
  query: URLSearchParams,
): { page: T[]; link: string | null } {
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const pageRaw = Number.parseInt(query.get('page') ?? '1', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const host = req.headers.host ?? 'forge';
  const proto = 'http';
  const base = `${proto}://${host}`;
  const path = (() => {
    try {
      return new URL(req.url ?? '/', 'http://forge').pathname;
    } catch {
      return '/';
    }
  })();
  const links: string[] = [];
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  if (page < totalPages) links.push(`<${base}${path}?per_page=${perPage}&page=${page + 1}>; rel="next"`);
  if (page > 1) links.push(`<${base}${path}?per_page=${perPage}&page=${page - 1}>; rel="prev"`);
  links.push(`<${base}${path}?per_page=${perPage}&page=1>; rel="first"`);
  links.push(`<${base}${path}?per_page=${perPage}&page=${totalPages}>; rel="last"`);
  return { page: slice, link: links.length > 0 ? links.join(', ') : null };
}

export function base64Of(data: Buffer): string {
  return data.toString('base64');
}

export function base64ToBytes(text: string): Buffer | null {
  const cleaned = text.replace(/[\r\n\t ]/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned) || cleaned.length % 4 !== 0) return null;
  try {
    return Buffer.from(cleaned, 'base64');
  } catch {
    return null;
  }
}
