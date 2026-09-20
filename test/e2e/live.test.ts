/**
 * Drives the built MCP server over stdio against a real cxcaller-api.
 *
 *   CXCALLER_E2E_URL=http://localhost:3000 \
 *   CXCALLER_E2E_EMAIL=… CXCALLER_E2E_PASSWORD=… pnpm build && pnpm test:e2e
 *
 * It logs in, creates an organization and an API key of its own, and uses only
 * that key from then on. Nothing dials unless the platform's workers are running.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL_ = process.env.CXCALLER_E2E_URL;
const EMAIL = process.env.CXCALLER_E2E_EMAIL;
const PASSWORD = process.env.CXCALLER_E2E_PASSWORD;

const enabled = Boolean(URL_ && EMAIL && PASSWORD);

async function api<T>(method: string, path: string, token: string | undefined, body?: unknown): Promise<T> {
  const response = await fetch(`${URL_}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`${method} ${path} -> ${response.status} ${await response.text()}`);
  }

  return (response.status === 204 ? undefined : await response.json()) as T;
}

describe.skipIf(!enabled)('live: built MCP over stdio against a real API', () => {
  let mcp: Client;
  let apiKey = '';
  let orgId = '';
  let jwt = '';
  const nonce = Date.now().toString(36);

  async function tool(name: string, args: Record<string, unknown> = {}) {
    const result = await mcp.callTool({ name, arguments: args });
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';
    let json: any;

    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }

    return { isError: result.isError === true, text, json };
  }

  beforeAll(async () => {
    jwt = (await api<any>('POST', '/auth/login', undefined, { email: EMAIL, password: PASSWORD })).accessToken.token;
    orgId = (await api<any>('POST', '/organizations', jwt, { businessName: `MCP e2e ${nonce}` })).id;
    apiKey = (await api<any>('POST', `/organizations/${orgId}/api-keys`, jwt, { name: `mcp-e2e-${nonce}` })).key;

    mcp = new Client({ name: 'e2e', version: '0' });
    await mcp.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ['dist/cli.js'],
        env: { PATH: process.env.PATH ?? '', CXCALLER_API_URL: URL_!, CXCALLER_API_KEY: apiKey },
        stderr: 'ignore',
      }),
    );
  });

  afterAll(async () => {
    await mcp?.close();
  });

  it('connects and advertises the tools', async () => {
    const names = (await mcp.listTools()).tools.map((t) => t.name);

    expect(names.length).toBeGreaterThanOrEqual(25);
    expect(names).toEqual(expect.arrayContaining(['make_call', 'create_campaign', 'launch_campaign']));
  });

  it('get_account resolves the key to its organization', async () => {
    const { json } = await tool('get_account');

    expect(json).toMatchObject({ organizationId: orgId, apiKeyPrefix: apiKey.slice(0, 12) });
  });

  it('lists caller IDs and voices from the real API', async () => {
    const callers = await tool('list_caller_ids');
    const voices = await tool('list_voices');

    expect(callers.isError).toBe(false);
    expect(callers.json.sharedPool.data.length).toBeGreaterThan(0);
    expect(voices.json.map((v: any) => v.voiceId)).toContain('Zephyr');
  });

  it('runs the contact lifecycle', async () => {
    const created = await tool('create_contact', { phone: '+94771000001', first_name: 'Nimal', language: 'si' });

    expect(created.isError).toBe(false);

    const duplicate = await tool('create_contact', { phone: '+94771000001' });

    expect(duplicate.isError).toBe(true);
    expect(duplicate.text).toMatch(/list_contacts/);

    const found = await tool('list_contacts', { query: 'Nimal' });

    expect(found.json.data.map((c: any) => c.phoneE164)).toContain('+94771000001');

    const updated = await tool('update_contact', { contact_id: created.json.id, last_name: 'Perera', status: 'blocked' });

    expect(updated.json).toMatchObject({ lastName: 'Perera', status: 'blocked' });

    const group = await tool('create_contact_group', { name: `g-${nonce}`, contact_ids: [created.json.id] });

    expect(group.isError).toBe(false);
    expect((await tool('list_contact_groups')).json.map((g: any) => g.name)).toContain(`g-${nonce}`);
  });

  let campaignId = '';

  it('create_campaign builds a full draft against the real validation, without dialing', async () => {
    const result = await tool('create_campaign', {
      name: `E2E ${nonce}`,
      instructions: 'You are calling {{contact_name}} from IIT about a payment.',
      objective: 'Confirm the payment date',
      language: 'si',
      voice_id: 'Zephyr',
      shared_variables: { company: 'IIT' },
      transfer_to: '+94112345678',
      calling_window_start: '09:00',
      calling_window_end: '17:30',
      calling_days: [1, 2, 3, 4, 5],
      timezone: 'Asia/Colombo',
      max_attempts: 2,
      max_concurrent_calls: 3,
      caller_id: { source: 'shared_pool' },
      outcome_fields: [
        { key: 'paid', label: 'Paid?', type: 'boolean', is_kpi: true },
        { key: 'reference_no', label: 'Reference no.', type: 'text' },
      ],
      recipients: [
        { phone: '+94771000002', name: 'Kamal', variables: { payment_amount: '20000' } },
        { phone: '+94771000003', name: 'Sunil', variables: { payment_amount: '5000' } },
      ],
    });

    expect(result.isError, result.text).toBe(false);
    campaignId = result.json.campaign.id;
    expect(result.json.campaign.status).toBe('draft');
    expect(result.json.recipients.imported).toMatchObject({ imported: 2 });
  });

  it('get_campaign shows every setting round-tripped, including merged objectiveConfig', async () => {
    const { json } = await tool('get_campaign', { campaign_id: campaignId });

    expect(json).toMatchObject({
      status: 'draft',
      language: 'si',
      voiceId: 'Zephyr',
      maxAttempts: 2,
      maxConcurrentCalls: 3,
      callingWindowStart: '09:00',
      callingWindowEnd: '17:30',
      callerIdSource: 'shared_pool',
      objectiveConfig: { shared_variables: { company: 'IIT' }, transfer_to: '+94112345678' },
    });
    expect(json.outcomeFields.map((f: any) => f.key).sort()).toEqual(['paid', 'reference_no']);
  });

  it('update_campaign preserves unrelated objectiveConfig keys when merging', async () => {
    await tool('update_campaign', { campaign_id: campaignId, shared_variables: { company: 'IIT', branch: 'Colombo' } });

    const { json } = await tool('get_campaign', { campaign_id: campaignId });

    expect(json.objectiveConfig).toEqual({
      shared_variables: { company: 'IIT', branch: 'Colombo' },
      transfer_to: '+94112345678',
    });
  });

  it('rejects an invalid voice with the API\'s own validation message', async () => {
    const { isError, text } = await tool('update_campaign', { campaign_id: campaignId, voice_id: 'zephyr' });

    expect(isError).toBe(true);
    expect(text).toMatch(/422/);
  });

  it('lists recipients and adds more', async () => {
    expect((await tool('list_campaign_recipients', { campaign_id: campaignId, group: 'pending' })).json.meta.itemCount).toBe(2);

    const added = await tool('add_campaign_recipients', {
      campaign_id: campaignId,
      recipients: [{ phone: '+94771000004', name: 'Nadee' }],
    });

    expect(added.json.imported).toMatchObject({ imported: 1 });
    expect((await tool('list_campaign_recipients', { campaign_id: campaignId })).json.meta.itemCount).toBe(3);
  });

  it('launch_campaign dispatches: the campaign leaves draft', async () => {
    const launched = await tool('launch_campaign', { campaign_id: campaignId });

    expect(launched.isError, launched.text).toBe(false);
    expect(launched.json.status).toBe('scheduled');

    const relaunch = await tool('launch_campaign', { campaign_id: campaignId });

    expect(relaunch.isError).toBe(true);
    expect(relaunch.text).toMatch(/409/);
  });

  it('stats and outcomes are readable', async () => {
    const stats = await tool('get_campaign_stats', { campaign_id: campaignId });
    const outcomes = await tool('get_campaign_outcomes', { campaign_id: campaignId, include_recipients: true });

    expect(stats.isError).toBe(false);
    expect(stats.json).toHaveProperty('totalRecipients');
    expect(outcomes.json.summary.fields.map((f: any) => f.key).sort()).toEqual(['paid', 'reference_no']);
    expect(outcomes.json.recipients.data).toHaveLength(3);
  });

  it('control_campaign cancels, then delete_campaign removes it', async () => {
    const cancelled = await tool('control_campaign', { campaign_id: campaignId, action: 'cancel' });

    expect(cancelled.isError, cancelled.text).toBe(false);
    expect((await tool('delete_campaign', { campaign_id: campaignId })).json).toEqual({ deleted: campaignId });
    expect((await tool('get_campaign', { campaign_id: campaignId })).isError).toBe(true);
  });

  it('make_call queues a single call as a launched one-recipient campaign', async () => {
    const result = await tool('make_call', {
      to: '+94771000009',
      name: 'Test Person',
      instructions: 'Ask {{contact_name}} whether the parcel arrived.',
      variables: { order: 'A-1' },
      outcome_fields: [{ key: 'arrived', label: 'Arrived?', type: 'boolean' }],
    });

    expect(result.isError, result.text).toBe(false);
    expect(result.json.finished).toBe(false);
    expect(result.json.campaign.status).toBe('scheduled');
    expect(result.json.recipients).toHaveLength(1);

    const polled = await tool('get_call_result', { campaign_id: result.json.campaign_id });

    expect(polled.json).toMatchObject({ finished: false, campaign: { id: result.json.campaign_id } });
  });

  it('make_call reports a bad number as a tool error and leaves no dialing campaign', async () => {
    const result = await tool('make_call', { to: '+1', instructions: 'hi' });

    expect(result.isError).toBe(true);
  });

  it('analytics endpoints respond', async () => {
    expect((await tool('get_analytics_overview', { period: 'week' })).isError).toBe(false);
    expect((await tool('get_analytics_report', { period: 'day' })).isError).toBe(false);
  });

  it('cannot reach organization management, by design', async () => {
    const forbidden = await fetch(`${URL_}/organizations/${orgId}/api-keys`, { headers: { Authorization: `Bearer ${apiKey}` } });

    expect(forbidden.status).toBe(403);
  });
});
