import type http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clientAddress, createHttpServer, hostAllowed, type DrainState } from '../src/http.js';
import { fakeApi, KEY, ORG_ID, testConfig, whoamiRoute, type Handler } from './helpers.js';

const servers: http.Server[] = [];
let stderr: string[] = [];

beforeEach(() => {
  stderr = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => (stderr.push(String(chunk)), true));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

async function start(env: Record<string, string> = {}, routes: Record<string, Handler> = {}, drain?: DrainState) {
  const api = fakeApi({
    ...whoamiRoute,
    [`GET /organizations/${ORG_ID}/campaigns`]: () => ({ json: { data: [], meta: {} } }),
    ...routes,
  });
  // Deliberately set: the hosted server must ignore a server-level key.
  const config = testConfig({ CXCALLER_API_KEY: 'cxk_server_side_key', ...env });
  const server = createHttpServer(config, { host: '0.0.0.0', port: 0, fetch: api.fetch }, drain);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);

  return { api, port: (server.address() as AddressInfo).port };
}

const LIST = { jsonrpc: '2.0', id: 1, method: 'tools/list' };

function rpc(port: number, headers: Record<string, string>, body: unknown = LIST) {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  });
}

const auth = { Authorization: `Bearer ${KEY}` };

describe('tenant authentication', () => {
  it('has no server-side fallback key: an anonymous caller is refused, not served as a tenant', async () => {
    const { port, api } = await start();
    const response = await rpc(port, {});

    expect(response.status).toBe(401);
    expect(api.calls).toHaveLength(0);
  });

  it('never sends the server-side key upstream', async () => {
    const { port, api } = await start();

    await rpc(port, auth, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_campaigns', arguments: {} } });

    expect(api.calls.every((call) => call.headers.Authorization === `Bearer ${KEY}`)).toBe(true);
  });

  it('authenticates before reading the body, so anonymous callers cannot make it buffer megabytes', async () => {
    const { port } = await start();
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'x'.repeat(5 * 1024 * 1024),
    });

    expect(response.status).toBe(401);
  });
});

describe('per-organization limits', () => {
  it('rate limits per organization and says when to retry', async () => {
    const { port } = await start({ CXCALLER_MCP_RATE_LIMIT_PER_MINUTE: '3' });
    const statuses = [];

    for (let i = 0; i < 5; i++) {
      statuses.push((await rpc(port, auth)).status);
    }

    expect(statuses).toEqual([200, 200, 200, 429, 429]);

    const limited = await rpc(port, auth);

    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(((await limited.json()) as { error: { message: string } }).error.message).toMatch(/3 requests\/minute/);
  });

  it('counts by organization, not by key: a second key does not buy a second allowance', async () => {
    const { port } = await start({ CXCALLER_MCP_RATE_LIMIT_PER_MINUTE: '2' });

    await rpc(port, { Authorization: 'Bearer cxk_key_one' });
    await rpc(port, { Authorization: 'Bearer cxk_key_two' });

    expect((await rpc(port, { Authorization: 'Bearer cxk_key_three' })).status).toBe(429);
  });

  it('keeps organizations apart: one tenant hitting its limit does not affect another', async () => {
    const OTHER_ORG = '99999999-9999-4999-8999-999999999999';
    const { port } = await start(
      { CXCALLER_MCP_RATE_LIMIT_PER_MINUTE: '1' },
      {
        'GET /api-key/whoami': (request) => ({
          json: {
            ...(whoamiRoute['GET /api-key/whoami']!(request) as { json: object }).json,
            organizationId: request.headers.Authorization === 'Bearer cxk_other' ? OTHER_ORG : ORG_ID,
          },
        }),
      },
    );

    await rpc(port, auth);

    expect((await rpc(port, auth)).status).toBe(429);
    expect((await rpc(port, { Authorization: 'Bearer cxk_other' })).status).toBe(200);
  });

  it('caps concurrent requests per organization and frees the slot when one finishes', async () => {
    let releaseSlow!: () => void;
    const gate = new Promise<void>((resolve) => (releaseSlow = resolve));
    const { port } = await start(
      { CXCALLER_MCP_MAX_CONCURRENT: '1' },
      { [`GET /organizations/${ORG_ID}/campaigns`]: async () => (await gate, { json: { data: [] } }) },
    );
    const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_campaigns', arguments: {} } };

    const slow = rpc(port, auth, call);

    await vi.waitFor(async () => expect((await rpc(port, auth)).status).toBe(429));
    releaseSlow();
    expect((await slow).status).toBe(200);
    expect((await rpc(port, auth)).status).toBe(200);
  });
});

describe('credential guessing', () => {
  const bad = { 'GET /api-key/whoami': () => ({ status: 401, json: { message: 'Unauthorized' } }) };

  it('blocks an address after too many rejected keys, without any more upstream lookups', async () => {
    const { port, api } = await start({ CXCALLER_MCP_FAILED_AUTH_PER_MINUTE: '3' }, bad);

    for (let i = 0; i < 3; i++) {
      expect((await rpc(port, { Authorization: `Bearer cxk_guess_${i}` })).status).toBe(401);
    }

    const before = api.calls.length;
    const blocked = await rpc(port, { Authorization: 'Bearer cxk_guess_4' });

    expect(blocked.status).toBe(429);
    expect(api.calls.length).toBe(before);
  });

  it('counts missing keys too', async () => {
    const { port } = await start({ CXCALLER_MCP_FAILED_AUTH_PER_MINUTE: '2' });

    await rpc(port, {});
    await rpc(port, {});

    expect((await rpc(port, {})).status).toBe(429);
  });

  it('does not let one tenant\'s good traffic be blocked by another address failing', async () => {
    const { port } = await start({ CXCALLER_MCP_FAILED_AUTH_PER_MINUTE: '1', CXCALLER_MCP_TRUST_PROXY: 'true' });

    await rpc(port, { 'CF-Connecting-IP': '203.0.113.9' });
    expect((await rpc(port, { 'CF-Connecting-IP': '203.0.113.9' })).status).toBe(429);
    expect((await rpc(port, { ...auth, 'CF-Connecting-IP': '198.51.100.7' })).status).toBe(200);
  });
});

describe('client address', () => {
  const req = (headers: Record<string, string>) =>
    ({ headers, socket: { remoteAddress: '10.0.0.5' } }) as unknown as http.IncomingMessage;

  it('ignores proxy headers unless told to trust them, so an address cannot be spoofed', () => {
    expect(clientAddress(req({ 'cf-connecting-ip': '1.2.3.4' }), false)).toBe('10.0.0.5');
  });

  it('prefers CF-Connecting-IP, then the first X-Forwarded-For hop, then the socket', () => {
    expect(clientAddress(req({ 'cf-connecting-ip': '1.2.3.4', 'x-forwarded-for': '5.6.7.8' }), true)).toBe('1.2.3.4');
    expect(clientAddress(req({ 'x-forwarded-for': '5.6.7.8, 9.9.9.9' }), true)).toBe('5.6.7.8');
    expect(clientAddress(req({}), true)).toBe('10.0.0.5');
  });
});

describe('host allow-list', () => {
  it('serves only the listed names when set', () => {
    expect(hostAllowed('mcp.cxcaller.com', '0.0.0.0', ['mcp.cxcaller.com'])).toBe(true);
    expect(hostAllowed('MCP.cxcaller.com:443', '0.0.0.0', ['mcp.cxcaller.com'])).toBe(true);
    expect(hostAllowed('evil.example.com', '0.0.0.0', ['mcp.cxcaller.com'])).toBe(false);
    expect(hostAllowed(undefined, '0.0.0.0', ['mcp.cxcaller.com'])).toBe(false);
  });

  it('refuses a foreign host on /mcp but still answers health probes by pod IP', async () => {
    const { port } = await start({ CXCALLER_MCP_ALLOWED_HOSTS: 'mcp.cxcaller.com' });
    const { request } = await import('node:http');
    const status = (path: string, host: string, method = 'GET') =>
      new Promise<number>((resolve, reject) => {
        const r = request({ host: '127.0.0.1', port, path, method, headers: { Host: host } }, (res) => (res.resume(), resolve(res.statusCode ?? 0)));

        r.on('error', reject);
        r.end();
      });

    expect(await status('/healthz', '10.4.2.7:8080')).toBe(200);
    expect(await status('/readyz', '10.4.2.7:8080')).toBe(200);
    expect(await status('/mcp', 'evil.example.com', 'POST')).toBe(403);
    expect(await status('/mcp', 'mcp.cxcaller.com', 'POST')).toBe(401);
  });
});

describe('browser clients (CORS)', () => {
  it('answers a preflight without credentials and allows the auth headers', async () => {
    const { port } = await start();
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://claude.ai', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-allow-headers')).toMatch(/Authorization/);
    expect(response.headers.get('access-control-allow-headers')).toMatch(/X-API-Key/);
  });

  it('sets CORS headers on real responses, including errors', async () => {
    const { port } = await start();

    expect((await rpc(port, {})).headers.get('access-control-allow-origin')).toBe('*');
    expect((await rpc(port, auth)).headers.get('access-control-allow-origin')).toBe('*');
  });
});

describe('draining', () => {
  it('reports not-ready and refuses new work once draining, so the balancer moves on', async () => {
    const drain = { draining: false };
    const { port } = await start({}, {}, drain);

    expect((await fetch(`http://127.0.0.1:${port}/readyz`)).status).toBe(200);
    drain.draining = true;

    const ready = await fetch(`http://127.0.0.1:${port}/readyz`);

    expect(ready.status).toBe(503);
    expect(((await ready.json()) as { status: string }).status).toBe('draining');
    expect((await rpc(port, auth)).status).toBe(503);
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
  });
});

describe('observability', () => {
  it('returns a request id and logs one structured line per request, without the key or the body', async () => {
    const { port } = await start();
    const secretArgs = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_contacts', arguments: { query: 'PERSONAL-DATA-Nimal' } } };
    const fullKey = `${KEY}_THE_SECRET_REMAINDER`;
    const response = await rpc(port, { Authorization: `Bearer ${fullKey}` }, secretArgs);
    const requestId = response.headers.get('x-request-id');

    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);

    const line = stderr.map((entry) => JSON.parse(entry)).find((entry) => entry.message === 'request' && entry.requestId === requestId);

    expect(line).toMatchObject({
      severity: 'INFO',
      status: 200,
      method: 'POST',
      path: '/mcp',
      rpc: 'tools/call',
      tool: 'list_contacts',
      org: ORG_ID,
      keyPrefix: 'cxk_testkey',
    });
    expect(typeof line.ms).toBe('number');
    // The prefix (which identifies a key in a list) is logged; the secret never is.
    expect(stderr.join('')).not.toContain(fullKey);
    expect(stderr.join('')).not.toContain('THE_SECRET_REMAINDER');
    expect(stderr.join('')).not.toContain('PERSONAL-DATA-Nimal');
  });

  it('logs rejected requests too, at INFO, and server faults at ERROR', async () => {
    const { port } = await start();

    await rpc(port, {});

    expect(stderr.map((entry) => JSON.parse(entry)).some((entry) => entry.status === 401 && entry.severity === 'INFO')).toBe(true);
  });

  it('does not log health probes', async () => {
    const { port } = await start();

    await fetch(`http://127.0.0.1:${port}/healthz`);
    await fetch(`http://127.0.0.1:${port}/readyz`);

    expect(stderr).toHaveLength(0);
  });
});

describe('make_call wait cap', () => {
  it('advertises the configured maximum, kept under the edge\'s 100 s limit by default', async () => {
    const { connect } = await import('./helpers.js');
    const { mcp } = await connect({});
    const tool = (await mcp.listTools()).tools.find((t) => t.name === 'make_call');
    const wait = (tool?.inputSchema.properties as Record<string, { maximum?: number }>).wait_seconds;

    expect(wait?.maximum).toBe(80);
  });

  it('is configurable', async () => {
    const { connect } = await import('./helpers.js');
    const { mcp } = await connect({}, { CXCALLER_MCP_MAX_WAIT_SECONDS: '30' });
    const tool = (await mcp.listTools()).tools.find((t) => t.name === 'make_call');

    expect((tool?.inputSchema.properties as Record<string, { maximum?: number }>).wait_seconds?.maximum).toBe(30);
  });
});
