import { describe, expect, it } from 'vitest';

import type { Identity } from '../src/client.js';
import { CxCallerApiError, CxCallerClient } from '../src/client.js';
import { fakeApi, KEY, ORG_ID, whoamiRoute } from './helpers.js';

function build(routes: Parameters<typeof fakeApi>[0], extra: Partial<ConstructorParameters<typeof CxCallerClient>[0]> = {}) {
  const api = fakeApi({ ...whoamiRoute, ...routes });
  const client = new CxCallerClient({ apiKey: KEY, baseUrl: 'http://api.test', fetch: api.fetch, ...extra });

  return { api, client };
}

describe('CxCallerClient', () => {
  it('sends the key as a Bearer token and JSON bodies with a content type', async () => {
    const { api, client } = build({ 'POST /things': () => ({ json: { ok: true } }) });

    await client.post('/things', { a: 1 });

    expect(api.calls[0]?.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(api.calls[0]?.headers['Content-Type']).toBe('application/json');
    expect(api.calls[0]?.body).toEqual({ a: 1 });
  });

  it('drops undefined, null and empty query values', async () => {
    const { api, client } = build({ 'GET /things': () => ({ json: [] }) });

    await client.get('/things', { query: { page: 2, q: '', status: undefined, x: null, flag: false } });

    expect(api.calls[0]?.query).toEqual({ page: '2', flag: 'false' });
  });

  it('scopes org requests to the organization the key is bound to, resolving it once', async () => {
    const { api, client } = build({ 'GET /organizations/:id/campaigns': () => ({ json: [] }) });

    await client.orgGet('/campaigns');
    await client.orgGet('/campaigns');

    expect(api.calls.filter((c) => c.path === '/api-key/whoami')).toHaveLength(1);
    expect(api.calls.at(-1)?.path).toBe(`/organizations/${ORG_ID}/campaigns`);
  });

  it('shares identity lookups through an injected cache', async () => {
    const store = new Map<string, Identity>();
    const cache = { get: (k: string) => store.get(k), set: (k: string, v: Identity) => void store.set(k, v) };
    const first = build({}, { identityCache: cache });
    const second = build({}, { identityCache: cache });

    await first.client.whoami();
    await second.client.whoami();

    expect(first.api.calls).toHaveLength(1);
    expect(second.api.calls).toHaveLength(0);
  });

  describe('errors', () => {
    it('explains a rejected key without leaking a raw 401 body', async () => {
      const { client } = build({ 'GET /x': () => ({ status: 401, json: { message: 'Unauthorized' } }) });

      await expect(client.get('/x')).rejects.toThrow(/rejected the API key/);
    });

    it('joins validation message arrays', async () => {
      const { client } = build({
        'POST /x': () => ({ status: 422, json: { message: ['name must be a string', 'phone is bad'] } }),
      });

      await expect(client.post('/x', {})).rejects.toThrow('422 name must be a string; phone is bad');
    });

    it('surfaces what a launch is missing, with guidance', async () => {
      const { client } = build({
        'POST /x': () => ({
          status: 422,
          json: { message: 'error.campaign_incomplete', missing: ['recipients', 'caller_id'] },
        }),
      });

      const error = await client.post('/x').catch((e: unknown) => e);

      expect(error).toBeInstanceOf(CxCallerApiError);
      expect((error as CxCallerApiError).code).toBe('error.campaign_incomplete');
      expect((error as Error).message).toMatch(/missing: recipients, caller_id/);
      expect((error as Error).message).toMatch(/Fix everything in `missing`/);
    });

    it('names the placeholders recipients have no value for', async () => {
      const { client } = build({
        'POST /x': () => ({
          status: 422,
          json: {
            message: 'error.campaign_incomplete',
            missing: ['variables'],
            missingVariables: [{ key: 'arrears_amount', recipients: 4 }],
          },
        }),
      });

      await expect(client.post('/x')).rejects.toThrow(
        /missing: variables\) \(no value for: arrears_amount for 4 recipient\(s\)\)/,
      );
    });

    it('reports an unreachable API as a network error naming the host', async () => {
      const client = new CxCallerClient({
        apiKey: KEY,
        baseUrl: 'http://api.test',
        fetch: (async () => {
          throw new TypeError('fetch failed');
        }) as typeof fetch,
      });

      await expect(client.post('/x')).rejects.toThrow(/Could not reach the CXCaller API at http:\/\/api\.test/);
    });
  });

  describe('retries', () => {
    it('retries a GET through a transient 503', async () => {
      let hits = 0;
      const { client } = build({
        'GET /x': () => (++hits < 3 ? { status: 503, json: {} } : { json: { ok: true } }),
      });

      await expect(client.get('/x')).resolves.toEqual({ ok: true });
      expect(hits).toBe(3);
    });

    it('never retries a POST, since a repeat could place a second call', async () => {
      let hits = 0;
      const { client } = build({ 'POST /x': () => (hits++, { status: 503, json: {} }) });

      await expect(client.post('/x')).rejects.toThrow(/503/);
      expect(hits).toBe(1);
    });

    it('does not retry a client error', async () => {
      let hits = 0;
      const { client } = build({ 'GET /x': () => (hits++, { status: 404, json: { message: 'nope' } }) });

      await expect(client.get('/x')).rejects.toThrow(/404/);
      expect(hits).toBe(1);
    });
  });
});
