import { describe, expect, it } from 'vitest';

import { CAMPAIGN_ID, connect, ORG_ID, type Handler } from './helpers.js';

const C = `/organizations/${ORG_ID}/campaigns`;

interface CampaignFake {
  /** The content review's answers: to the verify, then to each read while still pending. */
  verdicts?: string[];
  /** What the campaign reads as once launched. */
  launchedStatus?: string;
}

/**
 * The happy-path campaign API: every write echoes success. The campaign is an
 * unverified draft until verified, and the review approves it unless told otherwise.
 */
function campaignRoutes(
  overrides: Record<string, Handler> = {},
  { verdicts = ['approved'], launchedStatus = 'scheduled' }: CampaignFake = {},
): Record<string, Handler> {
  const campaign = { id: CAMPAIGN_ID, name: 'x', status: 'draft', reviewStatus: 'unverified', objectiveConfig: {} };
  let answered = 0;
  const review = () => {
    campaign.reviewStatus = verdicts[Math.min(answered++, verdicts.length - 1)] as string;

    return { json: { ...campaign } };
  };

  return {
    [`POST ${C}`]: () => ({ status: 201, json: { id: CAMPAIGN_ID, name: 'x', status: 'draft' } }),
    [`PATCH ${C}/${CAMPAIGN_ID}`]: () => ({ json: { id: CAMPAIGN_ID } }),
    [`PUT ${C}/${CAMPAIGN_ID}/numbers`]: () => ({ json: {} }),
    [`PUT ${C}/${CAMPAIGN_ID}/outcome-fields`]: () => ({ json: [] }),
    [`POST ${C}/${CAMPAIGN_ID}/contacts/import`]: () => ({ json: { imported: 2, created: 2, reused: 0, total: 2 } }),
    [`POST ${C}/${CAMPAIGN_ID}/recipients`]: () => ({ json: { added: 5, total: 5 } }),
    [`GET ${C}/${CAMPAIGN_ID}/recipients`]: () => ({ json: { data: [], meta: { itemCount: 2 } } }),
    [`POST ${C}/${CAMPAIGN_ID}/verify`]: review,
    [`POST ${C}/${CAMPAIGN_ID}/launch`]: () => {
      campaign.status = launchedStatus;

      return { json: { ...campaign } };
    },
    [`GET ${C}/${CAMPAIGN_ID}`]: () => (campaign.reviewStatus === 'pending' ? review() : { json: { ...campaign } }),
    ...overrides,
  };
}

describe('tool registration', () => {
  it('exposes the full surface by default', async () => {
    const { mcp } = await connect({});
    const names = (await mcp.listTools()).tools.map((tool) => tool.name);

    expect(names).toEqual(
      expect.arrayContaining(['get_account', 'make_call', 'create_campaign', 'launch_campaign', 'get_call_result', 'list_contacts']),
    );
    expect(new Set(names).size).toBe(names.length);
  });

  it('hides every mutating tool in read-only mode, and keeps the reads', async () => {
    const { mcp, tools } = await connect({}, { CXCALLER_MCP_READ_ONLY: 'true' });
    const listed = (await mcp.listTools()).tools;

    expect(tools).not.toContain('make_call');
    expect(tools).not.toContain('launch_campaign');
    expect(tools).not.toContain('delete_contacts');
    expect(listed.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
    expect(tools).toEqual(expect.arrayContaining(['get_account', 'list_campaigns', 'get_call_result', 'get_analytics_report']));
  });

  it('restricts to the requested toolsets', async () => {
    const { tools } = await connect({}, { CXCALLER_MCP_TOOLSETS: 'calls' });

    expect(tools).toContain('make_call');
    expect(tools).toContain('get_account');
    expect(tools).not.toContain('create_campaign');
    expect(tools).not.toContain('list_contacts');
  });

  it('tells clients which tools reach people and which destroy data', async () => {
    const { mcp } = await connect({});
    const byName = Object.fromEntries((await mcp.listTools()).tools.map((tool) => [tool.name, tool.annotations]));

    expect(byName.make_call).toMatchObject({ readOnlyHint: false, openWorldHint: true });
    expect(byName.launch_campaign).toMatchObject({ readOnlyHint: false, openWorldHint: true });
    expect(byName.delete_campaign).toMatchObject({ destructiveHint: true });
    expect(byName.delete_contacts).toMatchObject({ destructiveHint: true });
    expect(byName.delete_campaigns).toMatchObject({ destructiveHint: true });
    expect(byName.delete_contact_group).toMatchObject({ destructiveHint: true });
    expect(byName.remove_campaign_recipients).toMatchObject({ destructiveHint: true });
    expect(byName.create_support_ticket).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(byName.get_campaign).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(byName.update_campaign?.destructiveHint).toBe(false);
  });
});

describe('create_campaign', () => {
  const args = {
    name: 'Payment reminders',
    instructions: 'Remind {{contact_name}} about payment.',
    language: 'si',
    voice_id: 'Zephyr',
    shared_variables: { company: 'IIT' },
    transfer_to: '+94112345678',
    max_concurrent_calls: 3,
    caller_id: { source: 'shared_pool' },
    outcome_fields: [{ key: 'paid', label: 'Paid?', type: 'boolean', is_kpi: true }],
    recipients: [{ phone: '+94771234567', name: 'Nimal', variables: { payment_amount: '20000' } }],
  };

  it('builds a draft in order and does NOT dispatch unless asked', async () => {
    const { call, api } = await connect(campaignRoutes());
    const result = await call('create_campaign', args);

    expect(result.isError).toBe(false);
    expect(api.sequence()).toEqual([
      `POST /campaigns`,
      `PATCH /campaigns/${CAMPAIGN_ID}`,
      `PUT /campaigns/${CAMPAIGN_ID}/numbers`,
      `PUT /campaigns/${CAMPAIGN_ID}/outcome-fields`,
      `POST /campaigns/${CAMPAIGN_ID}/contacts/import`,
      `GET /campaigns/${CAMPAIGN_ID}`,
    ]);
    expect(api.sequence().some((entry) => entry.endsWith('/launch'))).toBe(false);
    expect((result.json as { note: string }).note).toMatch(/draft; nothing has been dialed/);
  });

  it('translates arguments to the API vocabulary', async () => {
    const { call, api } = await connect(campaignRoutes());

    await call('create_campaign', args);

    const patch = api.calls.find((c) => c.method === 'PATCH');
    const fields = api.calls.find((c) => c.path.endsWith('/outcome-fields'));
    const imported = api.calls.find((c) => c.path.endsWith('/contacts/import'));

    expect(patch?.body).toEqual({
      systemPrompt: 'Remind {{contact_name}} about payment.',
      language: 'si',
      voiceId: 'Zephyr',
      maxConcurrentCalls: 3,
      objectiveConfig: { shared_variables: { company: 'IIT' }, transfer_to: '+94112345678' },
    });
    expect(fields?.body).toEqual({ fields: [{ key: 'paid', label: 'Paid?', fieldType: 'boolean', isKpi: true }] });
    expect(imported?.body).toEqual({
      contacts: [{ phoneE164: '+94771234567', contactName: 'Nimal', variables: { payment_amount: '20000' } }],
    });
  });

  it('launches when launch=true and reports it as scheduled', async () => {
    const { call, api } = await connect(campaignRoutes());
    const result = await call('create_campaign', { ...args, launch: true });

    expect(api.sequence()).toContain(`POST /campaigns/${CAMPAIGN_ID}/launch`);
    expect((result.json as { note: string }).note).toMatch(/Launched/);
  });

  it('attaches groups and contacts through the recipients endpoint', async () => {
    const { call, api } = await connect(campaignRoutes());
    const groupId = '44444444-4444-4444-8444-444444444444';

    await call('create_campaign', { name: 'g', group_ids: [groupId] });

    const attach = api.calls.find((c) => c.path.endsWith(`${CAMPAIGN_ID}/recipients`) && c.method === 'POST');

    expect(attach?.body).toEqual({ groupIds: [groupId] });
  });

  it('names the failed step and the surviving draft, without dialing, when a later step fails', async () => {
    const { call, api } = await connect(
      campaignRoutes({
        [`POST ${C}/${CAMPAIGN_ID}/contacts/import`]: () => ({ status: 422, json: { message: ['phoneE164 must be valid'] } }),
      }),
    );
    const result = await call('create_campaign', { ...args, launch: true });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('Failed at "attach recipients"');
    expect(result.text).toContain(CAMPAIGN_ID);
    expect(result.text).toMatch(/nothing has been dialed/);
    expect(api.sequence().some((entry) => entry.endsWith('/launch'))).toBe(false);
  });

  it('rejects a malformed phone number before any request is made', async () => {
    const { call, api } = await connect(campaignRoutes());
    const result = await call('create_campaign', { name: 'x', recipients: [{ phone: '0771234567' }] });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/E\.164/);
    expect(api.sequence()).toEqual([]);
  });

  it('rejects a recipient list beyond the configured cap', async () => {
    const { call, api } = await connect(campaignRoutes(), { CXCALLER_MCP_MAX_RECIPIENTS: '2' });
    const recipients = ['+94771111111', '+94772222222', '+94773333333'].map((phone) => ({ phone }));
    const result = await call('create_campaign', { name: 'x', recipients });

    expect(result.isError).toBe(true);
    expect(api.sequence()).toEqual([]);
  });
});

describe('launch_campaign guardrail', () => {
  it('launches within the limit', async () => {
    const { call, api } = await connect(campaignRoutes());
    const result = await call('launch_campaign', { campaign_id: CAMPAIGN_ID });

    expect(result.isError).toBe(false);
    expect(api.sequence()).toEqual([
      `GET /campaigns/${CAMPAIGN_ID}/recipients`,
      `GET /campaigns/${CAMPAIGN_ID}`,
      `POST /campaigns/${CAMPAIGN_ID}/verify`,
      `POST /campaigns/${CAMPAIGN_ID}/launch`,
    ]);
    expect(api.calls.find((c) => c.path.endsWith('/recipients'))?.query).toEqual({ take: '1' });
  });

  it('refuses, and does not dial, when the real recipient count exceeds the limit', async () => {
    const { call, api } = await connect(
      campaignRoutes({ [`GET ${C}/${CAMPAIGN_ID}/recipients`]: () => ({ json: { data: [], meta: { itemCount: 5000 } } }) }),
      { CXCALLER_MCP_MAX_RECIPIENTS: '1000' },
    );
    const result = await call('launch_campaign', { campaign_id: CAMPAIGN_ID });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/5000 recipients.*limit of 1000/);
    expect(result.text).toMatch(/Nothing was dialed/);
    expect(api.sequence().some((entry) => entry.endsWith('/launch'))).toBe(false);
  });

  it('turns an incomplete-campaign 422 into actionable text', async () => {
    const { call } = await connect(
      campaignRoutes({
        [`POST ${C}/${CAMPAIGN_ID}/launch`]: () => ({
          status: 422,
          json: { message: 'error.campaign_incomplete', missing: ['caller_id', 'agent'] },
        }),
      }),
    );
    const result = await call('launch_campaign', { campaign_id: CAMPAIGN_ID });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/missing: caller_id, agent/);
  });
});

describe('launch_campaign verification', () => {
  const launched = (sequence: string[]) => sequence.some((entry) => entry.endsWith('/launch'));

  it('launches an already-approved campaign without resubmitting it', async () => {
    const { call, api } = await connect(
      campaignRoutes({
        [`GET ${C}/${CAMPAIGN_ID}`]: () => ({ json: { id: CAMPAIGN_ID, status: 'draft', reviewStatus: 'approved' } }),
      }),
    );
    const result = await call('launch_campaign', { campaign_id: CAMPAIGN_ID });

    expect(result.isError).toBe(false);
    expect(api.sequence()).not.toContain(`POST /campaigns/${CAMPAIGN_ID}/verify`);
    expect(launched(api.sequence())).toBe(true);
  });

  it('waits out a pending review, then launches', async () => {
    const { call, api } = await connect(campaignRoutes({}, { verdicts: ['pending', 'approved'] }), {
      CXCALLER_MCP_MAX_WAIT_SECONDS: '1',
    });
    const result = await call('launch_campaign', { campaign_id: CAMPAIGN_ID });

    expect(result.isError, result.text).toBe(false);
    expect(api.sequence().slice(1)).toEqual([
      `GET /campaigns/${CAMPAIGN_ID}`,
      `POST /campaigns/${CAMPAIGN_ID}/verify`,
      `GET /campaigns/${CAMPAIGN_ID}`,
      `POST /campaigns/${CAMPAIGN_ID}/launch`,
    ]);
  });

  it('does not dial a campaign the review flagged, and passes on the reason', async () => {
    const { call, api } = await connect(
      campaignRoutes({
        [`POST ${C}/${CAMPAIGN_ID}/verify`]: () => ({
          json: { id: CAMPAIGN_ID, status: 'draft', reviewStatus: 'flagged', reviewReason: 'Asks for card numbers' },
        }),
      }),
    );
    const result = await call('launch_campaign', { campaign_id: CAMPAIGN_ID });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/"flagged"/);
    expect(result.text).toMatch(/Nothing was dialed/);
    expect(result.text).toContain('Asks for card numbers');
    expect(result.text).toMatch(/admin/);
    expect(launched(api.sequence())).toBe(false);
  });

  it('does not dial rejected content, and says to change it', async () => {
    const { call, api } = await connect(campaignRoutes({}, { verdicts: ['rejected'] }));
    const result = await call('launch_campaign', { campaign_id: CAMPAIGN_ID });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/update_campaign/);
    expect(launched(api.sequence())).toBe(false);
  });

  it('gives up without dialing when the review does not answer in time', async () => {
    const { call, api } = await connect(campaignRoutes({}, { verdicts: ['pending'] }), {
      CXCALLER_MCP_MAX_WAIT_SECONDS: '1',
    });
    const result = await call('launch_campaign', { campaign_id: CAMPAIGN_ID });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/"pending"/);
    expect(result.text).toMatch(/launch_campaign again/);
    expect(launched(api.sequence())).toBe(false);
  });

  it('leaves a campaign that is not a draft to the API, without submitting it', async () => {
    const { call, api } = await connect(
      campaignRoutes({
        [`GET ${C}/${CAMPAIGN_ID}`]: () => ({ json: { id: CAMPAIGN_ID, status: 'running', reviewStatus: 'approved' } }),
        [`POST ${C}/${CAMPAIGN_ID}/launch`]: () => ({ status: 409, json: { message: 'error.campaign_not_launchable' } }),
      }),
    );
    const result = await call('launch_campaign', { campaign_id: CAMPAIGN_ID });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Only a draft campaign can be launched/);
    expect(api.sequence()).not.toContain(`POST /campaigns/${CAMPAIGN_ID}/verify`);
  });

  it('launches as before on an API without verification', async () => {
    const { call, api } = await connect(
      campaignRoutes({ [`GET ${C}/${CAMPAIGN_ID}`]: () => ({ json: { id: CAMPAIGN_ID, status: 'draft' } }) }),
    );
    const result = await call('launch_campaign', { campaign_id: CAMPAIGN_ID });

    expect(result.isError).toBe(false);
    expect(api.sequence()).not.toContain(`POST /campaigns/${CAMPAIGN_ID}/verify`);
  });

  it('create_campaign with launch=true names the surviving draft when the review flags it', async () => {
    const { call, api } = await connect(campaignRoutes({}, { verdicts: ['flagged'] }));
    const result = await call('create_campaign', { name: 'x', instructions: 'Hi', launch: true });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('Failed at "launch"');
    expect(result.text).toContain(CAMPAIGN_ID);
    expect(launched(api.sequence())).toBe(false);
  });
});

describe('verify_campaign', () => {
  it('submits the draft and reports the verdict with what to do next', async () => {
    const { call, api } = await connect(campaignRoutes({}, { verdicts: ['flagged'] }));
    const result = await call('verify_campaign', { campaign_id: CAMPAIGN_ID });

    expect(result.isError).toBe(false);
    expect(api.sequence()).toEqual([`GET /campaigns/${CAMPAIGN_ID}`, `POST /campaigns/${CAMPAIGN_ID}/verify`]);
    expect(result.json).toMatchObject({ campaign_id: CAMPAIGN_ID, status: 'draft', reviewStatus: 'flagged' });
    expect((result.json as { note: string }).note).toMatch(/admin/);
  });

  it('does not resubmit an approved campaign', async () => {
    const { call, api } = await connect(
      campaignRoutes({
        [`GET ${C}/${CAMPAIGN_ID}`]: () => ({ json: { id: CAMPAIGN_ID, status: 'draft', reviewStatus: 'approved' } }),
      }),
    );
    const result = await call('verify_campaign', { campaign_id: CAMPAIGN_ID });

    expect(result.json).toMatchObject({ reviewStatus: 'approved' });
    expect(api.sequence()).toEqual([`GET /campaigns/${CAMPAIGN_ID}`]);
  });

  it('is hidden in read-only mode and never reaches people', async () => {
    expect((await connect({}, { CXCALLER_MCP_READ_ONLY: 'true' })).tools).not.toContain('verify_campaign');

    const { mcp } = await connect({});
    const annotations = (await mcp.listTools()).tools.find((tool) => tool.name === 'verify_campaign')?.annotations;

    expect(annotations).toMatchObject({ readOnlyHint: false, openWorldHint: false, destructiveHint: false });
  });
});

describe('update_campaign', () => {
  it('merges shared_variables onto the existing objectiveConfig instead of replacing it', async () => {
    const { call, api } = await connect(
      campaignRoutes({
        [`GET ${C}/${CAMPAIGN_ID}`]: () => ({
          json: { id: CAMPAIGN_ID, objectiveConfig: { transfer_to: '+94112345678', custom: 1 } },
        }),
      }),
    );

    await call('update_campaign', { campaign_id: CAMPAIGN_ID, shared_variables: { company: 'IIT' } });

    expect(api.calls.find((c) => c.method === 'PATCH')?.body).toEqual({
      objectiveConfig: { transfer_to: '+94112345678', custom: 1, shared_variables: { company: 'IIT' } },
    });
  });

  it('sends only what changed, distinguishing null (clear) from omitted', async () => {
    const { call, api } = await connect(campaignRoutes());

    await call('update_campaign', { campaign_id: CAMPAIGN_ID, voice_id: null, max_attempts: 2 });

    expect(api.calls.find((c) => c.method === 'PATCH')?.body).toEqual({ voiceId: null, maxAttempts: 2 });
  });

  it('makes no PATCH when only caller_id changes', async () => {
    const { call, api } = await connect(campaignRoutes());

    await call('update_campaign', { campaign_id: CAMPAIGN_ID, caller_id: { source: 'shared_pool' } });

    expect(api.calls.some((c) => c.method === 'PATCH')).toBe(false);
    expect(api.calls.some((c) => c.method === 'PUT' && c.path.endsWith('/numbers'))).toBe(true);
  });
});

describe('make_call', () => {
  const callRoutes = (status = 'scheduled', attempts: unknown[] = [], verdicts?: string[]) =>
    campaignRoutes(
      {
        [`GET ${C}/${CAMPAIGN_ID}/recipients`]: () => ({ json: { data: [{ id: 'r1', status: 'queued' }], meta: { itemCount: 1 } } }),
        [`GET ${C}/${CAMPAIGN_ID}/attempts`]: () => ({ json: { data: attempts, meta: {} } }),
      },
      { launchedStatus: status, verdicts },
    );

  it('creates and launches a single-recipient campaign, called once, one at a time', async () => {
    const { call, api } = await connect(callRoutes());
    const result = await call('make_call', {
      to: '+94771234567',
      name: 'Nimal',
      instructions: 'Ask Nimal if he got the parcel.',
      variables: { order: 'A-1' },
      language: 'en',
    });

    expect(result.isError).toBe(false);
    expect(api.sequence().slice(0, 8)).toEqual([
      'POST /campaigns',
      `PATCH /campaigns/${CAMPAIGN_ID}`,
      `POST /campaigns/${CAMPAIGN_ID}/contacts/import`,
      `GET /campaigns/${CAMPAIGN_ID}/recipients`,
      `GET /campaigns/${CAMPAIGN_ID}`,
      `POST /campaigns/${CAMPAIGN_ID}/verify`,
      `POST /campaigns/${CAMPAIGN_ID}/launch`,
      `GET /campaigns/${CAMPAIGN_ID}`,
    ]);
    expect(api.calls.find((c) => c.method === 'PATCH')?.body).toMatchObject({
      systemPrompt: 'Ask Nimal if he got the parcel.',
      language: 'en',
      maxAttempts: 1,
      maxConcurrentCalls: 1,
    });
    expect(api.calls.find((c) => c.path.endsWith('/contacts/import'))?.body).toEqual({
      contacts: [{ phoneE164: '+94771234567', contactName: 'Nimal', language: 'en', variables: { order: 'A-1' } }],
    });
    expect(result.json).toMatchObject({ campaign_id: CAMPAIGN_ID, finished: false });
    expect((result.json as { note: string }).note).toMatch(/Poll get_call_result/);
  });

  it('requires instructions and a valid number', async () => {
    const { call, api } = await connect(callRoutes());

    expect((await call('make_call', { to: '+94771234567' })).isError).toBe(true);
    expect((await call('make_call', { to: '12345', instructions: 'hi' })).isError).toBe(true);
    expect(api.sequence()).toEqual([]);
  });

  it('returns the finished result, with transcript, when wait_seconds is given and the call ends', async () => {
    const attempt = { id: 'CALL-20260920-aaaa', status: 'completed' };
    const detail = { id: attempt.id, outcome: 'completed', summary: 'Confirmed.', transcript: [{ role: 'agent', text: 'Hi' }] };
    const { call } = await connect({
      ...callRoutes('completed', [attempt]),
      [`GET ${C}/${CAMPAIGN_ID}/attempts/${attempt.id}`]: () => ({ json: detail }),
    });
    const result = await call('make_call', { to: '+94771234567', instructions: 'Hi', wait_seconds: 5 });

    expect(result.json).toMatchObject({ finished: true, calls: [{ summary: 'Confirmed.' }] });
    expect((result.json as { note: string }).note).toMatch(/has finished/);
  });

  it('does not dial when the number cannot be attached, and names the surviving draft', async () => {
    const { call, api } = await connect(
      campaignRoutes({
        [`POST ${C}/${CAMPAIGN_ID}/contacts/import`]: () => ({ status: 422, json: { message: ['phoneE164 must be a valid phone number'] } }),
      }),
    );
    const result = await call('make_call', { to: '+94771234567', instructions: 'Hi' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('attach the person to call');
    expect(result.text).toContain(CAMPAIGN_ID);
    expect(api.sequence().some((entry) => entry.endsWith('/launch'))).toBe(false);
  });

  it('does not dial when the review flags the instructions, and names the surviving draft', async () => {
    const { call, api } = await connect(callRoutes('scheduled', [], ['flagged']));
    const result = await call('make_call', { to: '+94771234567', instructions: 'Hi' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('Failed at "dispatch"');
    expect(result.text).toContain(CAMPAIGN_ID);
    expect(api.sequence().some((entry) => entry.endsWith('/launch'))).toBe(false);
  });

  it('counts the wait for the review against the same ceiling as wait_seconds', async () => {
    const { call, api } = await connect(callRoutes('scheduled', [], ['pending', 'approved']), {
      CXCALLER_MCP_MAX_WAIT_SECONDS: '1',
    });
    const result = await call('make_call', { to: '+94771234567', instructions: 'Hi', wait_seconds: 1 });

    expect(result.isError, result.text).toBe(false);

    // The review used the whole budget, so the only read after launch is the result itself.
    const afterLaunch = api.sequence().slice(api.sequence().indexOf(`POST /campaigns/${CAMPAIGN_ID}/launch`) + 1);

    expect(afterLaunch.filter((entry) => entry === `GET /campaigns/${CAMPAIGN_ID}`)).toHaveLength(1);
  });

  const CONTACT_ID = '66666666-6666-4666-8666-666666666666';

  it('falls back to find-or-create-contact and still dials when contacts/import 500s (a known platform fault)', async () => {
    const { call, api } = await connect({
      ...callRoutes(),
      [`POST ${C}/${CAMPAIGN_ID}/contacts/import`]: () => ({ status: 500, json: { message: 'boom' } }),
      [`POST /organizations/${ORG_ID}/contacts`]: () => ({ status: 201, json: { id: CONTACT_ID } }),
    });
    const result = await call('make_call', { to: '+94771234567', name: 'Nimal', instructions: 'Ask about the parcel.' });

    expect(result.isError).toBe(false);
    expect(api.sequence().some((entry) => entry.endsWith('/launch'))).toBe(true);

    const createdContact = api.calls.find((c) => c.method === 'POST' && c.path.endsWith('/contacts'));

    expect(createdContact?.body).toEqual({ phoneE164: '+94771234567', firstName: 'Nimal' });

    const attach = api.calls.find((c) => c.method === 'POST' && c.path.endsWith(`${CAMPAIGN_ID}/recipients`));

    expect(attach?.body).toEqual({ contactIds: [CONTACT_ID] });
  });

  it('looks up the existing contact when the fallback create hits a duplicate phone number', async () => {
    const { call, api } = await connect({
      ...callRoutes(),
      [`POST ${C}/${CAMPAIGN_ID}/contacts/import`]: () => ({ status: 502, json: { message: 'bad gateway' } }),
      [`POST /organizations/${ORG_ID}/contacts`]: () => ({ status: 409, json: { message: 'error.contact_phone_already_exists' } }),
      [`GET /organizations/${ORG_ID}/contacts`]: () => ({ json: { data: [{ id: CONTACT_ID }] } }),
    });
    const result = await call('make_call', { to: '+94771234567', instructions: 'Hi' });

    expect(result.isError).toBe(false);

    const attach = api.calls.find((c) => c.method === 'POST' && c.path.endsWith(`${CAMPAIGN_ID}/recipients`));

    expect(attach?.body).toEqual({ contactIds: [CONTACT_ID] });
  });
});

describe('retry_campaign_recipient', () => {
  const RECIPIENT = '55555555-5555-4555-8555-555555555555';
  const retryRoute = `POST ${C}/${CAMPAIGN_ID}/recipients/${RECIPIENT}/retry`;
  const withStatus = (status: string) =>
    campaignRoutes({
      [`GET ${C}/${CAMPAIGN_ID}`]: () => ({ json: { id: CAMPAIGN_ID, status } }),
      [retryRoute]: () => ({ status: 201, json: {} }),
    });

  it('queues the retry on a running campaign', async () => {
    const { call, api } = await connect(withStatus('running'));
    const result = await call('retry_campaign_recipient', { campaign_id: CAMPAIGN_ID, recipient_id: RECIPIENT });

    expect(result.isError).toBe(false);
    expect(api.sequence()).toContain(`POST /campaigns/${CAMPAIGN_ID}/recipients/${RECIPIENT}/retry`);
    expect((result.json as { note: string }).note).toMatch(/within about 20 seconds/);
  });

  it('says nothing will be dialed until resume on a paused campaign', async () => {
    const { call } = await connect(withStatus('paused'));
    const result = await call('retry_campaign_recipient', { campaign_id: CAMPAIGN_ID, recipient_id: RECIPIENT });

    expect((result.json as { note: string }).note).toMatch(/resume/);
  });

  it.each(['completed', 'cancelled', 'failed'])(
    'refuses on a %s campaign instead of reporting a retry that will never be dialed',
    async (status) => {
      const { call, api } = await connect(withStatus(status));
      const result = await call('retry_campaign_recipient', { campaign_id: CAMPAIGN_ID, recipient_id: RECIPIENT });

      expect(result.isError).toBe(true);
      expect(result.text).toMatch(new RegExp(`is ${status}`));
      expect(result.text).toMatch(/create a new campaign/);
      expect(api.sequence().some((entry) => entry.endsWith('/retry'))).toBe(false);
    },
  );

  it('explains a recipient that is not in a retryable state', async () => {
    const { call } = await connect({
      ...withStatus('running'),
      [retryRoute]: () => ({ status: 409, json: { message: 'error.campaign_recipient_not_retryable' } }),
    });
    const result = await call('retry_campaign_recipient', { campaign_id: CAMPAIGN_ID, recipient_id: RECIPIENT });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/no_answer, failed or exhausted/);
  });
});

describe('get_call_result', () => {
  it('reports finished from the campaign status and fetches the latest calls in full', async () => {
    const { call, api } = await connect({
      [`GET ${C}/${CAMPAIGN_ID}`]: () => ({ json: { id: CAMPAIGN_ID, name: 'Call', status: 'running' } }),
      [`GET ${C}/${CAMPAIGN_ID}/recipients`]: () => ({ json: { data: [{ id: 'r1', status: 'in_progress' }] } }),
      [`GET ${C}/${CAMPAIGN_ID}/attempts`]: () => ({ json: { data: [{ id: 'CALL-1' }] } }),
      [`GET ${C}/${CAMPAIGN_ID}/attempts/CALL-1`]: () => ({ json: { id: 'CALL-1', status: 'answered' } }),
    });
    const result = await call('get_call_result', { campaign_id: CAMPAIGN_ID });

    expect(result.json).toMatchObject({ finished: false, campaign: { status: 'running' }, calls: [{ id: 'CALL-1' }] });
    expect(api.calls.find((c) => c.path.endsWith('/attempts') && c.method === 'GET')?.query).toMatchObject({ order: 'DESC' });
  });
});

describe('error handling', () => {
  it('returns API failures as tool errors the agent can read, not protocol errors', async () => {
    const { call } = await connect({
      [`GET ${C}/${CAMPAIGN_ID}/stats`]: () => ({ status: 404, json: { message: 'error.campaign_not_found' } }),
    });
    const result = await call('get_campaign_stats', { campaign_id: CAMPAIGN_ID });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('404');
  });

  it('refuses a non-UUID id at the schema, before any request', async () => {
    const { call, api } = await connect({});
    const result = await call('get_campaign_stats', { campaign_id: 'not-a-uuid' });

    expect(result.isError).toBe(true);
    expect(api.sequence()).toEqual([]);
  });

  it('truncates an enormous result and says so', async () => {
    const huge = 'x'.repeat(200_000);
    const { call } = await connect({
      [`GET ${C}/${CAMPAIGN_ID}/stats`]: () => ({ json: { blob: huge } }),
    });
    const result = await call('get_campaign_stats', { campaign_id: CAMPAIGN_ID });

    expect(result.isError).toBe(false);
    expect(result.text.length).toBeLessThan(90_000);
    expect(result.text).toMatch(/truncated/);
  });
});

describe('contacts and account', () => {
  it('maps contact fields and filters', async () => {
    const { call, api } = await connect({
      [`POST /organizations/${ORG_ID}/contacts`]: () => ({ status: 201, json: { id: 'c1' } }),
      [`GET /organizations/${ORG_ID}/contacts`]: () => ({ json: { data: [] } }),
    });

    await call('create_contact', { phone: '+94771234567', first_name: 'Nimal', group_id: '44444444-4444-4444-8444-444444444444' });
    await call('list_contacts', { query: 'nim', status: 'blocked', take: 5 });

    expect(api.calls[1]?.body).toEqual({
      phoneE164: '+94771234567',
      firstName: 'Nimal',
      groupId: '44444444-4444-4444-8444-444444444444',
    });
    expect(api.calls.at(-1)?.query).toEqual({ q: 'nim', status: 'blocked', take: '5' });
  });

  it('surfaces a duplicate contact with guidance', async () => {
    const { call } = await connect({
      [`POST /organizations/${ORG_ID}/contacts`]: () => ({ status: 409, json: { message: 'error.contact_phone_already_exists' } }),
    });
    const result = await call('create_contact', { phone: '+94771234567' });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/list_contacts/);
  });

  it('get_account returns the bound organization', async () => {
    const { call } = await connect({});

    expect((await call('get_account')).json).toMatchObject({ organizationId: ORG_ID, organizationName: 'Test Org' });
  });

  it('lists both caller-ID sources', async () => {
    const { call } = await connect({
      [`GET /organizations/${ORG_ID}/phone-numbers`]: () => ({ json: { data: [{ id: 'd1' }] } }),
      [`GET /organizations/${ORG_ID}/phone-numbers/pool`]: () => ({ json: { data: [{ id: 'p1' }] } }),
    });

    expect((await call('list_caller_ids')).json).toEqual({ dedicated: { data: [{ id: 'd1' }] }, sharedPool: { data: [{ id: 'p1' }] } });
  });
});

describe('campaign management', () => {
  const RECIPIENT = '55555555-5555-4555-8555-555555555555';
  const OTHER = '66666666-6666-4666-8666-666666666666';

  it('duplicates into a draft, translating the options', async () => {
    const { call, api } = await connect({
      [`POST ${C}/:id/duplicate`]: () => ({ status: 201, json: { id: OTHER, status: 'draft' } }),
    });
    const result = await call('duplicate_campaign', { campaign_id: CAMPAIGN_ID, name: 'Again', include_recipients: false });

    expect(result.json).toMatchObject({ id: OTHER, status: 'draft' });
    expect(api.sequence()).toEqual([`POST /campaigns/${CAMPAIGN_ID}/duplicate`]);
    expect(api.calls.at(-1)?.body).toEqual({ name: 'Again', includeRecipients: false });
  });

  it('bulk-deletes and passes on what was skipped', async () => {
    const skipped = [{ id: OTHER, reason: 'not_deletable' }];
    const { call, api } = await connect({
      [`POST ${C}/bulk-delete`]: () => ({ json: { deletedIds: [CAMPAIGN_ID], skipped } }),
    });
    const result = await call('delete_campaigns', { campaign_ids: [CAMPAIGN_ID, OTHER] });

    expect(result.json).toEqual({ deletedIds: [CAMPAIGN_ID], skipped });
    expect(api.calls.at(-1)?.body).toEqual({ campaignIds: [CAMPAIGN_ID, OTHER] });
  });

  it('updates recipients in one request, sending only what was given', async () => {
    const { call, api } = await connect({
      [`PATCH ${C}/:id/recipients`]: () => ({ json: { updated: 2 } }),
    });
    const result = await call('update_campaign_recipients', {
      campaign_id: CAMPAIGN_ID,
      updates: [
        { recipient_id: RECIPIENT, variables: { due_date: '21 May' } },
        { recipient_id: OTHER, context_override: null },
      ],
    });

    expect(result.json).toEqual({ updated: 2 });
    expect(api.sequence()).toEqual([`PATCH /campaigns/${CAMPAIGN_ID}/recipients`]);
    expect(api.calls.at(-1)?.body).toEqual({
      updates: [
        { campaignContactId: RECIPIENT, variables: { due_date: '21 May' } },
        { campaignContactId: OTHER, contextOverride: null },
      ],
    });
  });

  it('removes recipients and says that dialed ones stay', async () => {
    const { call, api } = await connect({
      [`POST ${C}/:id/recipients/bulk-remove`]: () => ({ status: 204 }),
    });
    const result = await call('remove_campaign_recipients', { campaign_id: CAMPAIGN_ID, recipient_ids: [RECIPIENT] });

    expect(result.json).toMatchObject({ requested: 1 });
    expect(result.text).toMatch(/already dialed were kept/);
    expect(api.calls.at(-1)?.body).toEqual({ campaignContactIds: [RECIPIENT] });
  });

  it('reads one recipient and the live calls', async () => {
    const { call, api } = await connect({
      [`GET ${C}/:id/recipients/:recipientId`]: () => ({ json: { id: RECIPIENT } }),
      [`GET ${C}/:id/currently-calling`]: () => ({ json: [] }),
    });

    await call('get_campaign_recipient', { campaign_id: CAMPAIGN_ID, recipient_id: RECIPIENT });
    await call('get_live_calls', { campaign_id: CAMPAIGN_ID });

    expect(api.sequence()).toEqual([
      `GET /campaigns/${CAMPAIGN_ID}/recipients/${RECIPIENT}`,
      `GET /campaigns/${CAMPAIGN_ID}/currently-calling`,
    ]);
  });
});

describe('contact groups', () => {
  const GROUP = '44444444-4444-4444-8444-444444444444';
  const G = `/organizations/${ORG_ID}/contact-groups`;

  it('gets, renames, removes members and deletes, in the API vocabulary', async () => {
    const { call, api } = await connect({
      [`GET ${G}/:id`]: () => ({ json: { id: GROUP } }),
      [`PATCH ${G}/:id`]: () => ({ json: { id: GROUP } }),
      [`POST ${G}/:id/contacts/remove`]: () => ({ json: { id: GROUP } }),
      [`DELETE ${G}/:id`]: () => ({ status: 204 }),
    });

    await call('get_contact_group', { group_id: GROUP });
    await call('update_contact_group', { group_id: GROUP, name: 'VIP', color: null });
    await call('remove_contacts_from_group', { group_id: GROUP, contact_ids: [CAMPAIGN_ID] });
    const deleted = await call('delete_contact_group', { group_id: GROUP });

    expect(api.sequence()).toEqual([
      `GET /contact-groups/${GROUP}`,
      `PATCH /contact-groups/${GROUP}`,
      `POST /contact-groups/${GROUP}/contacts/remove`,
      `DELETE /contact-groups/${GROUP}`,
    ]);
    expect(api.calls[2]?.body).toEqual({ name: 'VIP', color: null });
    expect(api.calls[3]?.body).toEqual({ contactIds: [CAMPAIGN_ID] });
    expect(deleted.json).toEqual({ deleted: GROUP });
  });
});

describe('phone numbers', () => {
  it('lists available dedicated numbers and reads one', async () => {
    const NUMBER = '77777777-7777-4777-8777-777777777777';
    const { call, api } = await connect({
      [`GET /organizations/${ORG_ID}/phone-numbers/available`]: () => ({ json: { data: [] } }),
      [`GET /organizations/${ORG_ID}/phone-numbers/:id`]: () => ({ json: { id: NUMBER } }),
    });

    await call('list_available_numbers', { take: 5 });
    await call('get_phone_number', { phone_number_id: NUMBER });

    expect(api.sequence()).toEqual(['GET /phone-numbers/available', `GET /phone-numbers/${NUMBER}`]);
  });
});

describe('support', () => {
  const TICKET = '88888888-8888-4888-8888-888888888888';
  const S = `/organizations/${ORG_ID}/support`;

  it('lists tickets, sending several statuses as a repeated parameter', async () => {
    const { call, api } = await connect({
      [`GET ${S}/tickets`]: () => ({ json: { data: [], meta: { itemCount: 0 } } }),
    });

    await call('list_support_tickets', { status: ['open', 'waiting_on_you'], query: 'CX-10' });

    expect(api.calls.at(-1)?.search).toBe('?q=CX-10&status=open&status=waiting_on_you');
  });

  it('opens a ticket as JSON with the API field names', async () => {
    const { call, api } = await connect({
      [`POST ${S}/tickets`]: () => ({ status: 201, json: { id: TICKET, reference: 'CX-1001', status: 'open' } }),
    });
    const result = await call('create_support_ticket', {
      subject: 'Calls fail',
      category: 'campaigns',
      description: 'Every call to +94 numbers fails.',
    });

    expect(result.json).toMatchObject({ reference: 'CX-1001' });
    expect(api.calls.at(-1)?.body).toEqual({
      subject: 'Calls fail',
      category: 'campaigns',
      description: 'Every call to +94 numbers fails.',
    });
  });

  it('replies, resolves and fetches an attachment', async () => {
    const ATTACHMENT = '99999999-9999-4999-8999-999999999999';
    const { call, api } = await connect({
      [`POST ${S}/tickets/:id/messages`]: () => ({ status: 201, json: { id: TICKET } }),
      [`PATCH ${S}/tickets/:id/status`]: () => ({ json: { id: TICKET, status: 'resolved' } }),
      [`GET ${S}/tickets/:id/attachments/:attachmentId`]: () => ({ json: { url: 'https://x', expiresAt: 'soon' } }),
    });

    await call('reply_to_support_ticket', { ticket_id: TICKET, body: 'Any news?' });
    await call('set_support_ticket_status', { ticket_id: TICKET, status: 'resolved' });
    await call('get_support_attachment_url', { ticket_id: TICKET, attachment_id: ATTACHMENT });

    expect(api.sequence()).toEqual([
      `POST /support/tickets/${TICKET}/messages`,
      `PATCH /support/tickets/${TICKET}/status`,
      `GET /support/tickets/${TICKET}/attachments/${ATTACHMENT}`,
    ]);
    expect(api.calls[2]?.body).toEqual({ status: 'resolved' });
  });

  it('refuses statuses only CXCaller staff can set', async () => {
    const { call, api } = await connect({});
    const result = await call('set_support_ticket_status', { ticket_id: TICKET, status: 'in_progress' });

    expect(result.isError).toBe(true);
    expect(api.sequence()).toEqual([]);
  });

  it('sends to the live chat and polls only newer messages', async () => {
    const after = '2026-09-26T10:00:00.000Z';
    const { call, api } = await connect({
      [`POST ${S}/chat/messages`]: () => ({ status: 201, json: [{ author: 'user' }, { author: 'automated' }] }),
      [`GET ${S}/chat/messages`]: () => ({ json: [] }),
    });

    const sent = await call('send_support_chat_message', { body: 'Hi, calls are failing' });
    await call('get_support_chat', { after });

    expect(sent.json).toHaveLength(2);
    expect(api.calls[1]?.body).toEqual({ body: 'Hi, calls are failing' });
    expect(api.calls.at(-1)?.query).toEqual({ after });
  });

  it('is its own toolset, and read-only mode keeps only the reads', async () => {
    const readOnly = await connect({}, { CXCALLER_MCP_READ_ONLY: 'true' });

    expect(readOnly.tools).toEqual(expect.arrayContaining(['list_support_tickets', 'get_support_ticket', 'get_support_chat']));
    expect(readOnly.tools).not.toContain('create_support_ticket');
    expect(readOnly.tools).not.toContain('send_support_chat_message');

    const onlySupport = await connect({}, { CXCALLER_MCP_TOOLSETS: 'support' });

    expect(onlySupport.tools).toContain('create_support_ticket');
    expect(onlySupport.tools).not.toContain('list_campaigns');
  });
});
