import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import type { Identity, IdentityCache } from './client.js';
import { CxCallerApiError, CxCallerClient } from './client.js';
import type { Config } from './config.js';
import { ConcurrencyLimiter, WindowLimiter } from './limits.js';
import { logEvent } from './log.js';
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

/** Client address for rate limiting. Proxy headers are honoured only when told to be. */
export function clientAddress(req: http.IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const cloudflare = firstHeader(req.headers['cf-connecting-ip'])?.trim();
    const forwarded = firstHeader(req.headers['x-forwarded-for'])?.split(',')[0]?.trim();

    if (cloudflare) {
      return cloudflare;
    }

    if (forwarded) {
      return forwarded;
    }
  }

  return req.socket.remoteAddress ?? 'unknown';
}

const CORS_HEADERS: Record<string, string> = {
  // Bearer tokens, not cookies, so a wildcard origin exposes nothing ambient.
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, X-API-Key, MCP-Protocol-Version, Mcp-Session-Id',
  'Access-Control-Expose-Headers': 'X-Request-Id, Retry-After',
  'Access-Control-Max-Age': '86400',
};

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

function hostName(hostHeader: string): string {
  const name = hostHeader.startsWith('[') ? hostHeader.slice(0, hostHeader.indexOf(']') + 1) : (hostHeader.split(':')[0] ?? '');

  return name.toLowerCase();
}

/**
 * DNS-rebinding and host-spoofing guard. With an explicit allow-list only those
 * names are served. Without one, a loopback-bound server answers only to
 * loopback names, and anything else is left to the network in front of it.
 */
export function hostAllowed(hostHeader: string | undefined, bindHost: string, allowedHosts: readonly string[]): boolean {
  if (allowedHosts.length > 0) {
    return hostHeader !== undefined && allowedHosts.includes(hostName(hostHeader));
  }

  if (!LOOPBACK_HOSTS.has(bindHost)) {
    return true;
  }

  return hostHeader !== undefined && LOOPBACK_HOSTS.has(hostName(hostHeader));
}

export interface HttpOptions {
  host: string;
  port: number;
  fetch?: typeof fetch;
}

/** Owned by whoever runs the server; flipped to drain it before shutdown. */
export interface DrainState {
  draining: boolean;
}

interface RpcMessage {
  method?: unknown;
  params?: { name?: unknown };
}

/** What a request asked for, for the log line: the JSON-RPC method and, for tool calls, the tool name. */
function describeRpc(body: unknown): { rpc?: string; tool?: string } {
  const message = (Array.isArray(body) ? body[0] : body) as RpcMessage | undefined;

  if (typeof message?.method !== 'string') {
    return {};
  }

  return {
    rpc: message.method,
    tool: message.method === 'tools/call' && typeof message.params?.name === 'string' ? message.params.name : undefined,
  };
}

export function createHttpServer(config: Config, options: HttpOptions, drain: DrainState = { draining: false }): http.Server {
  const identityCache = new MemoryIdentityCache();
  const limits = config.http;
  const perOrgRate = new WindowLimiter(limits.requestsPerMinute, 60_000);
  const perOrgConcurrency = new ConcurrencyLimiter(limits.maxConcurrent);
  const failedAuth = new WindowLimiter(limits.failedAuthPerMinute, 60_000);

  const sweeper = setInterval(() => {
    perOrgRate.sweep();
    failedAuth.sweep();
  }, 60_000);

  sweeper.unref();

  const server = http.createServer(async (req, res) => {
    const startedAt = Date.now();
    const requestId = randomUUID();
    const ip = clientAddress(req, limits.trustProxy);
    const audit: Record<string, unknown> = { requestId, ip, method: req.method };
    let release: (() => void) | undefined;

    res.setHeader('X-Request-Id', requestId);
    Object.entries(CORS_HEADERS).forEach(([name, value]) => res.setHeader(name, value));

    res.on('close', () => {
      release?.();

      if (audit.path !== '/healthz' && audit.path !== '/readyz') {
        logEvent(res.statusCode >= 500 ? 'ERROR' : 'INFO', 'request', { ...audit, status: res.statusCode, ms: Date.now() - startedAt });
      }
    });

    try {
      const url = new URL(req.url ?? '/', 'http://localhost');

      audit.path = url.pathname;

      // Probes address the pod by IP, so they cannot satisfy the host allow-list.
      if (url.pathname === '/healthz') {
        sendJson(res, 200, { status: 'ok' });

        return;
      }

      if (url.pathname === '/readyz') {
        sendJson(res, drain.draining ? 503 : 200, { status: drain.draining ? 'draining' : 'ready' });

        return;
      }

      if (!hostAllowed(req.headers.host, options.host, limits.allowedHosts)) {
        rpcError(res, 403, -32000, 'Forbidden host');

        return;
      }

      if (url.pathname !== '/mcp') {
        sendJson(res, 404, { error: 'Not found. The MCP endpoint is POST /mcp.' });

        return;
      }

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();

        return;
      }

      if (req.method !== 'POST') {
        rpcError(res, 405, -32000, 'Method not allowed. This server is stateless; use POST /mcp.', { Allow: 'POST, OPTIONS' });

        return;
      }

      if (drain.draining) {
        rpcError(res, 503, -32000, 'Server is shutting down; retry.', { 'Retry-After': '1' });

        return;
      }

      // A caller that keeps presenting bad credentials is cut off before it can
      // cost an upstream lookup per attempt, which would make this a key-guessing oracle.
      const blockedFor = failedAuth.retryAfter(ip);

      if (blockedFor !== null) {
        rpcError(res, 429, -32003, 'Too many rejected credentials from this address. Slow down.', { 'Retry-After': String(blockedFor) });

        return;
      }

      // Every caller brings their own key. There is deliberately no server-side
      // fallback: on a shared host it would let anyone act as that tenant.
      const apiKey = extractKey(req.headers);

      if (!apiKey) {
        failedAuth.hit(ip);
        rpcError(res, 401, -32001, 'Missing API key. Send "Authorization: Bearer <your CXCaller API key>".', {
          'WWW-Authenticate': 'Bearer realm="cxcaller"',
        });

        return;
      }

      const client = new CxCallerClient({
        apiKey,
        baseUrl: config.apiUrl,
        timeoutMs: config.requestTimeoutMs,
        identityCache,
        fetch: options.fetch,
      });

      let identity: Identity;

      try {
        identity = await client.whoami();
      } catch (error) {
        if (error instanceof CxCallerApiError && error.status === 401) {
          failedAuth.hit(ip);
          rpcError(res, 401, -32001, 'The CXCaller API rejected this API key (invalid or revoked).', {
            'WWW-Authenticate': 'Bearer realm="cxcaller", error="invalid_token"',
          });
        } else {
          rpcError(res, 502, -32002, `Could not verify the API key: ${error instanceof Error ? error.message : String(error)}`);
        }

        return;
      }

      // From here the caller is a known tenant. Limits are per organization, not
      // per key, so minting more keys does not multiply the allowance.
      audit.org = identity.organizationId;
      audit.keyPrefix = identity.apiKeyPrefix;

      const rateLimitedFor = perOrgRate.hit(identity.organizationId);

      if (rateLimitedFor !== null) {
        rpcError(res, 429, -32003, `Rate limit of ${limits.requestsPerMinute} requests/minute exceeded for this organization.`, {
          'Retry-After': String(rateLimitedFor),
        });

        return;
      }

      release = perOrgConcurrency.acquire(identity.organizationId) ?? undefined;

      if (!release) {
        rpcError(res, 429, -32003, `Too many concurrent requests (limit ${limits.maxConcurrent}) for this organization.`, { 'Retry-After': '1' });

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

      Object.assign(audit, describeRpc(body));

      const { server: mcpServer } = createServer(client, config);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });

      res.on('close', () => {
        void transport.close();
        void mcpServer.close();
      });

      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      logEvent('ERROR', 'unhandled error', { requestId, error: error instanceof Error ? error.message : String(error) });

      if (!res.headersSent) {
        rpcError(res, 500, -32603, 'Internal server error');
      }
    }
  });

  // Cloudflare holds origin connections open; keep-alive must outlast its idle
  // timeout or requests race a closing socket and surface as 502s.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
  server.on('close', () => clearInterval(sweeper));

  return server;
}

export async function runHttp(config: Config, options: HttpOptions): Promise<http.Server> {
  const drain: DrainState = { draining: false };
  const server = createHttpServer(config, options, drain);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, resolve);
  });

  logEvent('INFO', 'listening', {
    address: `http://${options.host}:${options.port}/mcp`,
    api: config.apiUrl,
    readOnly: config.readOnly,
    allowedHosts: config.http.allowedHosts,
    trustProxy: config.http.trustProxy,
  });

  const shutdown = (signal: string) => {
    if (drain.draining) {
      return;
    }

    drain.draining = true;
    logEvent('INFO', 'draining', { signal, graceMs: config.http.shutdownGraceMs });

    // Stop taking connections, close idle keep-alives, and let in-flight requests
    // finish: a make_call may be waiting on a call. Force-close after the grace period.
    server.close(() => {
      logEvent('INFO', 'drained');
      process.exit(0);
    });
    server.closeIdleConnections();

    setTimeout(() => {
      logEvent('WARNING', 'grace period elapsed; closing remaining connections');
      server.closeAllConnections();
      process.exit(0);
    }, config.http.shutdownGraceMs).unref();
  };

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));

  return server;
}
