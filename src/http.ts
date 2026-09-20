import { createHash } from 'node:crypto';
import http from 'node:http';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import type { Identity, IdentityCache } from './client.js';
import { CxCallerApiError, CxCallerClient } from './client.js';
import type { Config } from './config.js';
import { createServer } from './server.js';

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const IDENTITY_TTL_MS = 5 * 60 * 1000;
const IDENTITY_CACHE_MAX = 1000;

/**
 * Remembers which organization a key belongs to so a request does not pay a
 * whoami round trip. Holds a hash, not the key, and never caches a rejection —
 * a freshly created key must work at once. Revocation is still enforced: this
 * only skips the identity lookup, every tool call goes to the API.
 */
export class MemoryIdentityCache implements IdentityCache {
  private readonly entries = new Map<string, { identity: Identity; expiresAt: number }>();

  private static fingerprint(apiKey: string): string {
    return createHash('sha256').update(apiKey).digest('hex');
  }

  get(apiKey: string): Identity | undefined {
    const fingerprint = MemoryIdentityCache.fingerprint(apiKey);
    const entry = this.entries.get(fingerprint);

    if (!entry) {
      return undefined;
    }

    if (entry.expiresAt < Date.now()) {
      this.entries.delete(fingerprint);

      return undefined;
    }

    return entry.identity;
  }

  set(apiKey: string, identity: Identity): void {
    if (this.entries.size >= IDENTITY_CACHE_MAX) {
      const oldest = this.entries.keys().next().value;

      if (oldest !== undefined) {
        this.entries.delete(oldest);
      }
    }

    this.entries.set(MemoryIdentityCache.fingerprint(apiKey), {
      identity,
      expiresAt: Date.now() + IDENTITY_TTL_MS,
    });
  }
}

const BEARER = /^Bearer\s+(\S+)$/i;

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function extractKey(headers: http.IncomingHttpHeaders): string | undefined {
  const bearer = BEARER.exec(firstHeader(headers.authorization) ?? '');
  const key = (bearer?.[1] ?? firstHeader(headers['x-api-key']) ?? '').trim();

  return key.length > 0 ? key : undefined;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function rpcError(res: http.ServerResponse, status: number, code: number, message: string, headers: Record<string, string> = {}): void {
  sendJson(res, status, { jsonrpc: '2.0', error: { code, message }, id: null }, headers);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;

      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();

        return;
      }

      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** DNS-rebinding guard: when listening on loopback, only answer to loopback names. */
function hostAllowed(hostHeader: string | undefined, bindHost: string): boolean {
  if (!LOOPBACK_HOSTS.has(bindHost)) {
    return true;
  }

  if (!hostHeader) {
    return false;
  }

  const name = hostHeader.startsWith('[') ? hostHeader.slice(0, hostHeader.indexOf(']') + 1) : hostHeader.split(':')[0];

  return name !== undefined && LOOPBACK_HOSTS.has(name);
}

export interface HttpOptions {
  host: string;
  port: number;
  fetch?: typeof fetch;
}

export function createHttpServer(config: Config, options: HttpOptions): http.Server {
  const identityCache = new MemoryIdentityCache();

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');

      if (!hostAllowed(req.headers.host, options.host)) {
        rpcError(res, 403, -32000, 'Forbidden host');

        return;
      }

      if (url.pathname === '/healthz') {
        sendJson(res, 200, { status: 'ok' });

        return;
      }

      if (url.pathname !== '/mcp') {
        sendJson(res, 404, { error: 'Not found. The MCP endpoint is POST /mcp.' });

        return;
      }

      if (req.method !== 'POST') {
        rpcError(res, 405, -32000, 'Method not allowed. This server is stateless; use POST /mcp.', { Allow: 'POST' });

        return;
      }

      const apiKey = extractKey(req.headers) ?? config.apiKey;

      if (!apiKey) {
        rpcError(res, 401, -32001, 'Missing API key. Send "Authorization: Bearer <your CXCaller API key>".', {
          'WWW-Authenticate': 'Bearer realm="cxcaller"',
        });

        return;
      }

      let body: unknown;

      try {
        body = JSON.parse(await readBody(req));
      } catch (error) {
        const tooLarge = error instanceof Error && error.message === 'body too large';

        rpcError(res, tooLarge ? 413 : 400, tooLarge ? -32000 : -32700, tooLarge ? 'Request body too large' : 'Parse error: body is not valid JSON');

        return;
      }

      const client = new CxCallerClient({
        apiKey,
        baseUrl: config.apiUrl,
        timeoutMs: config.requestTimeoutMs,
        identityCache,
        fetch: options.fetch,
      });

      try {
        await client.whoami();
      } catch (error) {
        if (error instanceof CxCallerApiError && error.status === 401) {
          rpcError(res, 401, -32001, 'The CXCaller API rejected this API key (invalid or revoked).', {
            'WWW-Authenticate': 'Bearer realm="cxcaller", error="invalid_token"',
          });
        } else {
          rpcError(res, 502, -32002, `Could not verify the API key: ${error instanceof Error ? error.message : String(error)}`);
        }

        return;
      }

      const { server } = createServer(client, config);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });

      res.on('close', () => {
        void transport.close();
        void server.close();
      });

      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      console.error('[cxcaller-mcp] unhandled error:', error);

      if (!res.headersSent) {
        rpcError(res, 500, -32603, 'Internal server error');
      }
    }
  });
}

export async function runHttp(config: Config, options: HttpOptions): Promise<http.Server> {
  const server = createHttpServer(config, options);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, resolve);
  });

  console.error(`[cxcaller-mcp] listening on http://${options.host}:${options.port}/mcp (API: ${config.apiUrl})`);

  return server;
}
