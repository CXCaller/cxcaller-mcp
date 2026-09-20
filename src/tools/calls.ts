import { z } from 'zod';

import type { CxCallerClient } from '../client.js';
import { agentShape, applyCampaignConfig, attachRecipients, launchWithGuard, withProgress } from './campaigns.js';
import { defineTool, type AnyToolSpec, type ToolContext } from './define.js';
import { callerIdSchema, outcomeFieldsSchema, pagingShape, phoneSchema, uuidSchema } from './shared.js';

const FINISHED = new Set(['completed', 'cancelled', 'failed']);
const POLL_INTERVAL_MS = 3000;

interface Page<T> {
  data: T[];
}

interface CampaignSummary {
  id: string;
  name: string;
  status: string;
  stats?: unknown;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Everything known about a campaign's calls, in one object (built for single-call campaigns). */
export async function fetchCallResult(client: CxCallerClient, campaignId: string) {
  const [campaign, recipients, attempts] = await Promise.all([
    client.orgGet<CampaignSummary>(`/campaigns/${campaignId}`),
    client.orgGet<Page<unknown>>(`/campaigns/${campaignId}/recipients`, { take: 5 }),
    client.orgGet<Page<{ id: string }>>(`/campaigns/${campaignId}/attempts`, { take: 3, order: 'DESC' }),
  ]);

  const calls = await Promise.all(
    attempts.data.map((attempt) => client.orgGet(`/campaigns/${campaignId}/attempts/${attempt.id}`)),
  );

  return {
    finished: FINISHED.has(campaign.status),
    campaign: { id: campaign.id, name: campaign.name, status: campaign.status, stats: campaign.stats },
    recipients: recipients.data,
    calls,
  };
}

async function waitUntilFinished(client: CxCallerClient, campaignId: string, seconds: number): Promise<void> {
  const deadline = Date.now() + seconds * 1000;

  while (Date.now() < deadline) {
    const { status } = await client.orgGet<CampaignSummary>(`/campaigns/${campaignId}`);

    if (FINISHED.has(status)) {
      return;
    }

    await sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
  }
}

const idShape = { campaign_id: uuidSchema.describe('Campaign id (for make_call, the campaign_id it returned).') };

export function callTools(ctx: ToolContext): AnyToolSpec[] {
  const { client, config } = ctx;
  const maxWait = config.maxWaitSeconds;
  const { shared_variables: _sharedVariables, instructions: _instructions, ...agentOptions } = agentShape;

  return [
    defineTool({
      name: 'make_call',
      title: 'Make a phone call',
      toolset: 'calls',
      mutating: true,
      reachesPeople: true,
      description:
        'PLACES A REAL PHONE CALL to one person, made by an AI voice agent following your `instructions`. Only call this when the user has asked you to call this number, and never to numbers they did not give you. ' +
        'Dialing starts within about 20 seconds (the platform dispatches on a 20 s cycle) and the call is made once unless max_attempts says otherwise. ' +
        'Internally this creates and launches a one-recipient campaign, so the call also appears in the dashboard. It returns immediately with a campaign_id; poll get_call_result until finished is true (a call takes roughly 30 s to a few minutes), or set wait_seconds to wait here for up to ' + String(maxWait) + ' s. ' +
        'To collect structured answers (e.g. "did they agree to a callback?") declare outcome_fields; otherwise you only get a transcript and free-text summary.',
      inputSchema: {
        to: phoneSchema.describe('Number to call, E.164.'),
        name: z.string().optional().describe('The person\'s name; the agent can use it as {{contact_name}}.'),
        instructions: z
          .string()
          .min(1)
          .describe(
            'The voice agent\'s system prompt: who it is, who it is calling, what to say, what to find out, and when to end the call. Reference values from `variables` as {{name}}.',
          ),
        variables: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Facts about this person for the agent, e.g. {"payment_amount":"20000","due_date":"21 May"}.'),
        ...agentOptions,
        caller_id: callerIdSchema.optional().describe('Defaults to the shared pool.'),
        outcome_fields: outcomeFieldsSchema.optional(),
        scheduled_start_at: z
          .string()
          .datetime({ offset: true })
          .optional()
          .describe('Call at this time instead of straight away (ISO 8601).'),
        max_attempts: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .describe('Total tries if nobody picks up (default 1: one call, no redials).'),
        wait_seconds: z
          .number()
          .int()
          .min(0)
          .max(maxWait)
          .optional()
          .describe(`Wait up to this long for the call to finish and return its result. Default 0 (return immediately). Max ${maxWait}.`),
      },
      handler: async (args) => {
        const label = args.name ?? args.to;
        const campaign = await withProgress(undefined, 'create call', () =>
          client.orgPost<{ id: string }>('/campaigns', {
            name: `Call to ${label} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
          }),
        );
        const id = campaign.id;

        await withProgress(id, 'configure call', () =>
          applyCampaignConfig(client, id, {
            instructions: args.instructions,
            objective: args.objective,
            language: args.language,
            voice_id: args.voice_id,
            transfer_to: args.transfer_to,
            caller_id: args.caller_id,
            outcome_fields: args.outcome_fields,
            scheduled_start_at: args.scheduled_start_at,
            max_attempts: args.max_attempts ?? 1,
            max_concurrent_calls: 1,
          }),
        );

        await withProgress(id, 'attach the person to call', () =>
          attachRecipients(client, id, {
            recipients: [{ phone: args.to, name: args.name, language: args.language ?? undefined, variables: args.variables }],
          }),
        );

        await withProgress(id, 'dispatch', () => launchWithGuard(ctx, id));

        const wait = args.wait_seconds ?? 0;

        if (wait > 0) {
          await waitUntilFinished(client, id, wait);
        }

        const result = await fetchCallResult(client, id);

        return {
          campaign_id: id,
          ...result,
          note: result.finished
            ? 'The call has finished; see `calls` for the outcome, summary and transcript.'
            : 'The call is queued or in progress. Poll get_call_result with this campaign_id until finished is true.',
        };
      },
    }),

    defineTool({
      name: 'get_call_result',
      title: 'Get call result',
      toolset: 'calls',
      mutating: false,
      description:
        'The state and outcome of a call placed with make_call (or the latest calls of any campaign): whether it is finished, how it ended (completed, declined, no_answer, busy, failed, voicemail), duration, summary, key points, extracted answers, sentiment and the full transcript. Poll every ~5 s until finished is true.',
      inputSchema: idShape,
      handler: ({ campaign_id }) => fetchCallResult(client, campaign_id),
    }),

    defineTool({
      name: 'list_campaign_calls',
      title: 'List campaign calls',
      toolset: 'calls',
      mutating: false,
      description:
        'Lists call attempts in a campaign, newest last by default, with status, outcome, duration and extracted data. Use get_call for a transcript. Status runs queued → dialing → ringing → answered → completed, with declined, no_answer, busy and failed as other endings.',
      inputSchema: { ...idShape, ...pagingShape, order: z.enum(['ASC', 'DESC']).optional() },
      handler: ({ campaign_id, page, take, order }) =>
        client.orgGet(`/campaigns/${campaign_id}/attempts`, { page, take, order }),
    }),

    defineTool({
      name: 'get_call',
      title: 'Get call',
      toolset: 'calls',
      mutating: false,
      description:
        'One call in full: outcome, sentiment, summary, key points, action items, extracted answers, latency metrics, cost, and the turn-by-turn transcript.',
      inputSchema: {
        ...idShape,
        call_id: z.string().describe('The call id, e.g. "CALL-20260920-a1b2c3d4e5f60718" (from list_campaign_calls or get_call_result). Not a UUID.'),
      },
      handler: ({ campaign_id, call_id }) => client.orgGet(`/campaigns/${campaign_id}/attempts/${call_id}`),
    }),

    defineTool({
      name: 'get_call_recording_url',
      title: 'Get call recording URL',
      toolset: 'calls',
      mutating: false,
      description:
        'A short-lived signed URL to the audio recording of a call. Expires quickly, so hand it to the user promptly. It is a link only; the audio itself is not returned.',
      inputSchema: {
        ...idShape,
        call_id: z.string().describe('The call id, e.g. "CALL-20260920-a1b2c3d4e5f60718".'),
      },
      handler: ({ campaign_id, call_id }) =>
        client.orgGet(`/campaigns/${campaign_id}/attempts/${call_id}/recording`),
    }),
  ];
}
