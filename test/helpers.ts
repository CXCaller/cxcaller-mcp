import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { CxCallerClient } from '../src/client.js';
import type { Config } from '../src/config.js';
import { loadConfig } from '../src/config.js';
import { createServer } from '../src/server.js';

export const ORG_ID = '11111111-1111-4111-8111-111111111111';
export const CAMPAIGN_ID = '22222222-2222-4222-8222-222222222222';
export const KEY = 'cxk_testkey';

export interface Recorded {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  headers: Record<string, string>;
}

export interface Reply {
  status?: number;
  json?: unknown;
  headers?: Record<string, string>;
}

export type Handler = (request: Recorded) => Reply | Promise<Reply>;

/** A stand-in for the CXCaller API: routes are "METHOD /path" with `:param` segments. */
export function fakeApi(routes: Record<string, Handler>) {
  const calls: Recorded[] = [];
  const compiled = Object.entries(routes).map(([key, handler]) => {
    const [method, pattern] = key.split(' ') as [string, string];
    const regex = new RegExp(`^${pattern.replace(/:[a-zA-Z]+/g, '[^/]+')}$`);

    return { method, regex, handler };
  });

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const recorded: Recorded = {
      method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
    };

    calls.push(recorded);

    const route = compiled.find((entry) => entry.method === method && entry.regex.test(url.pathname));

    if (!route) {
      return new Response(JSON.stringify({ message: `no route for ${method} ${url.pathname}` }), { status: 404 });
    }

    const reply = await route.handler(recorded);

    return new Response(reply.json === undefined ? null : JSON.stringify(reply.json), {
      status: reply.status ?? 200,
      headers: reply.headers,
    });
  };

  return {
    fetch: fetchImpl,
    calls,
    /** "METHOD /path" for every call after whoami, for compact sequence assertions. */
    sequence: () =>
      calls
        .filter((call) => call.path !== '/api-key/whoami')
        .map((call) => `${call.method} ${call.path.replace(`/organizations/${ORG_ID}`, '')}`),
  };
}

export const whoamiRoute: Record<string, Handler> = {
  'GET /api-key/whoami': () => ({
    json: {
      organizationId: ORG_ID,
      organizationName: 'Test Org',
      defaultTimezone: 'Asia/Colombo',
      apiKeyId: '33333333-3333-4333-8333-333333333333',
      apiKeyName: 'test',
      apiKeyPrefix: 'cxk_testkey',
    },
  }),
};

export function testConfig(env: Record<string, string> = {}): Config {
  return loadConfig({ CXCALLER_API_URL: 'http://api.test', CXCALLER_API_KEY: KEY, ...env });
}

/** Wires an MCP client to the real server over an in-memory pipe, backed by a fake API. */
export async function connect(routes: Record<string, Handler>, env: Record<string, string> = {}) {
  const api = fakeApi({ ...whoamiRoute, ...routes });
  const config = testConfig(env);
  const client = new CxCallerClient({ apiKey: KEY, baseUrl: config.apiUrl, fetch: api.fetch });
  const { server, tools } = createServer(client, config);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'test', version: '0.0.0' });

  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);

  return {
    mcp,
    api,
    tools,
    async call(name: string, args: Record<string, unknown> = {}) {
      const result = await mcp.callTool({ name, arguments: args });
      const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';

      return { isError: result.isError === true, text, json: safeParse(text) };
    },
  };
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
