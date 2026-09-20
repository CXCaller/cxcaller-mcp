import type http from 'node:http';
import type { AddressInfo } from 'node:net';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createHttpServer, extractKey, MemoryIdentityCache } from '../src/http.js';
import { fakeApi, KEY, ORG_ID, testConfig, whoamiRoute, type Handler } from './helpers.js';

const servers: http.Server[] = [];

// Request logs go to stderr; keep test output readable.
beforeEach(() => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

async function start(routes: Record<string, Handler> = {}, env: Record<string, string> = {}) {
  const api = fakeApi({
    ...whoamiRoute,
    [`GET /organizations/${ORG_ID}/campaigns`]: () => ({ json: { data: [{ id: 'c1', name: 'Demo' }], meta: {} } }),
    ...routes,
  });
  const config = testConfig({ CXCALLER_API_KEY: '', ...env });
  const server = createHttpServer(config, { host: '127.0.0.1', port: 0, fetch: api.fetch });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);

  const { port } = server.address() as AddressInfo;

  return { api, url: `http://127.0.0.1:${port}`, port };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

async function post(url: string, headers: Record<string, string>, body: unknown) {
  const response = await fetch(`${url}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

  return { status: response.status, headers: response.headers, json: (await response.json().catch(() => undefined)) as any };
}

describe('Streamable HTTP transport', () => {
  it('serves a real MCP client: initialize, list tools, call a tool with the caller\'s own key', async () => {
    const { url, api } = await start();
    const client = new Client({ name: 'test', version: '0' });

    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${KEY}` } } }),
    );

    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    const result = await client.callTool({ name: 'list_campaigns', arguments: {} });

    expect(tools).toContain('make_call');
    expect((result.content as Array<{ text: string }>)[0]?.text).toContain('Demo');
    // The upstream call carried the same key the MCP client presented.
    expect(api.calls.filter((c) => c.path.includes('/campaigns')).every((c) => c.headers.Authorization === `Bearer ${KEY}`)).toBe(true);

    await client.close();
  });

  it('accepts X-API-Key as well as Bearer', async () => {
    const { url } = await start();
    const client = new Client({ name: 'test', version: '0' });

    await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { 'X-API-Key': KEY } } }));

    expect((await client.listTools()).tools.length).toBeGreaterThan(10);
    await client.close();
  });

  it('answers 401 with a challenge when no key is sent', async () => {
    const { url } = await start();
    const response = await post(url, {}, { jsonrpc: '2.0', id: 1, method: 'tools/list' });

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toMatch(/Bearer/);
    expect(response.json.error.message).toMatch(/Missing API key/);
  });

  it('answers 401 when the platform rejects the key', async () => {
    const { url } = await start({ 'GET /api-key/whoami': () => ({ status: 401, json: { message: 'Unauthorized' } }) });
    const response = await post(url, { Authorization: 'Bearer cxk_revoked' }, { jsonrpc: '2.0', id: 1, method: 'tools/list' });

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toMatch(/invalid_token/);
  });

  it('answers 502, not 401, when the platform is unreachable', async () => {
    const { url } = await start({ 'GET /api-key/whoami': () => ({ status: 503, json: {} }) });
    const response = await post(url, { Authorization: `Bearer ${KEY}` }, { jsonrpc: '2.0', id: 1, method: 'tools/list' });

    expect(response.status).toBe(502);
  });

  it('does not serve one caller\'s key to another', async () => {
    const seen: string[] = [];
    const { url } = await start({
      [`GET /organizations/${ORG_ID}/campaigns`]: (request) => {
        seen.push(request.headers.Authorization ?? '');

        return { json: { data: [] } };
      },
    });

    for (const key of ['cxk_alice', 'cxk_bob']) {
      const client = new Client({ name: 'test', version: '0' });

      await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
      await client.callTool({ name: 'list_campaigns', arguments: {} });
      await client.close();
    }

    expect(seen).toEqual(['Bearer cxk_alice', 'Bearer cxk_bob']);
  });

  it('rejects non-POST (the server is stateless)', async () => {
    const { url } = await start();
    const response = await fetch(`${url}/mcp`, { method: 'GET', headers: { Authorization: `Bearer ${KEY}` } });

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST, OPTIONS');
  });

  it('rejects invalid JSON', async () => {
    const { url } = await start();
    const response = await post(url, { Authorization: `Bearer ${KEY}` }, '{not json');

    expect(response.status).toBe(400);
    expect(response.json.error.code).toBe(-32700);
  });

  it('serves a health check without a key, and 404s other paths', async () => {
    const { url } = await start();

    expect((await fetch(`${url}/healthz`)).status).toBe(200);
    expect((await fetch(`${url}/nope`)).status).toBe(404);
  });

  it('blocks DNS-rebinding: a loopback server refuses a foreign Host header', async () => {
    const { port } = await start();
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { Host: 'evil.example.com', 'Content-Type': 'application/json' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });

      req.on('error', reject);
      req.end();
    });

    expect(status).toBe(403);
  });

  it('honours read-only mode per server', async () => {
    const { url } = await start({}, { CXCALLER_MCP_READ_ONLY: 'true' });
    const client = new Client({ name: 'test', version: '0' });

    await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${KEY}` } } }));

    const names = (await client.listTools()).tools.map((tool) => tool.name);

    expect(names).not.toContain('make_call');
    expect(names).toContain('get_call_result');
    await client.close();
  });
});

describe('extractKey', () => {
  it('reads Bearer, then X-API-Key, and ignores blanks', () => {
    expect(extractKey({ authorization: 'Bearer cxk_a' })).toBe('cxk_a');
    expect(extractKey({ 'x-api-key': ' cxk_b ' })).toBe('cxk_b');
    expect(extractKey({ authorization: 'Bearer cxk_a', 'x-api-key': 'cxk_b' })).toBe('cxk_a');
    expect(extractKey({ 'x-api-key': '   ' })).toBeUndefined();
    expect(extractKey({})).toBeUndefined();
  });
});

describe('MemoryIdentityCache', () => {
  const identity = { organizationId: 'o', organizationName: 'n', defaultTimezone: 'UTC', apiKeyId: 'k', apiKeyName: null, apiKeyPrefix: 'cxk_' };

  it('round-trips by key and misses for another', () => {
    const cache = new MemoryIdentityCache();

    cache.set('cxk_a', identity);

    expect(cache.get('cxk_a')).toEqual(identity);
    expect(cache.get('cxk_b')).toBeUndefined();
  });

  it('never stores the plaintext key', () => {
    const cache = new MemoryIdentityCache();

    cache.set('cxk_secret', identity);

    expect(JSON.stringify([...(cache as unknown as { entries: Map<string, unknown> }).entries.keys()])).not.toContain('cxk_secret');
  });
});
