import { z } from 'zod';

import type { CxCallerClient } from '../client.js';
import { CxCallerApiError } from '../client.js';
import { defineTool, ToolError, type AnyToolSpec, type ToolContext } from './define.js';
import {
  callerIdSchema,
  compact,
  outcomeFieldsSchema,
  pagingShape,
  phoneSchema,
  uuidSchema,
} from './shared.js';

// ---- Shapes shared by create_campaign, update_campaign and make_call ----------

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export const agentShape = {
  instructions: z
    .string()
    .nullable()
    .optional()
    .describe(
      'The voice agent\'s system prompt: who it is, who it is calling, what to say, what to find out, when to end the call. Reference per-recipient values as {{variable_name}}; every recipient must then have that variable or the call fails before dialing. Values without a placeholder are still shown to the agent as context. null clears it.',
    ),
  objective: z
    .string()
    .nullable()
    .optional()
    .describe('One sentence on what a successful call achieves. Steers the post-call summary and extraction, not the live conversation.'),
  language: z
    .string()
    .nullable()
    .optional()
    .describe('Language the agent speaks: BCP-47 tag or name ("si", "si-LK" and "Sinhala" all work).'),
  voice_id: z
    .string()
    .nullable()
    .optional()
    .describe('A voice from list_voices (case-sensitive). null restores the default voice.'),
  shared_variables: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Variables given to every recipient, e.g. {"company":"IIT"}. A recipient\'s own variables override these.'),
  transfer_to: phoneSchema
    .optional()
    .describe('E.164 number the agent may warm-transfer the caller to.'),
};

export const scheduleShape = {
  scheduled_start_at: z
    .string()
    .datetime({ offset: true })
    .nullable()
    .optional()
    .describe('ISO 8601 start time. null/omitted = start as soon as launched.'),
  calling_window_start: z
    .string()
    .regex(HHMM, 'Use "HH:MM" 24-hour')
    .nullable()
    .optional()
    .describe('Earliest local time of day to dial, "HH:MM". null = no lower bound.'),
  calling_window_end: z
    .string()
    .regex(HHMM, 'Use "HH:MM" 24-hour')
    .nullable()
    .optional()
    .describe('Latest local time of day to dial, "HH:MM". An end before the start spans midnight. null = no upper bound.'),
  calling_days: z
    .array(z.number().int().min(1).max(7))
    .optional()
    .describe('ISO weekdays to dial on, 1 = Monday … 7 = Sunday. Empty array = every day.'),
  respect_contact_timezone: z
    .boolean()
    .optional()
    .describe('Use each contact\'s own timezone for the calling window when they have one.'),
  timezone: z.string().optional().describe('IANA timezone for the calling window, e.g. "Asia/Colombo".'),
  max_attempts: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe('Total calls per recipient including the first. Platform default 1.'),
  retry_delay_minutes: z.number().int().min(0).optional(),
  retry_on_dispositions: z
    .array(z.enum(['no_answer', 'busy', 'failed', 'declined', 'voicemail', 'completed']))
    .optional()
    .describe('Outcomes that trigger another attempt. Default: no_answer, busy, failed.'),
  max_concurrent_calls: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Simultaneous calls for this campaign. Platform default 1, meaning one person is called at a time.'),
};

export const recipientSchema = z.object({
  phone: phoneSchema,
  name: z.string().optional().describe('How the agent addresses them; available to the prompt as {{contact_name}}.'),
  language: z.string().optional(),
  variables: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Per-recipient values, e.g. {"payment_amount":"20000"}. Highest precedence.'),
});

type AgentArgs = z.infer<z.ZodObject<typeof agentShape>>;
type ScheduleArgs = z.infer<z.ZodObject<typeof scheduleShape>>;

export interface CampaignConfigArgs extends AgentArgs, ScheduleArgs {
  name?: string;
  caller_id?: z.infer<typeof callerIdSchema>;
  outcome_fields?: z.infer<typeof outcomeFieldsSchema>;
}

export type RecipientInput = z.infer<typeof recipientSchema>;

export interface RecipientSources {
  recipients?: RecipientInput[];
  group_ids?: string[];
  contact_ids?: string[];
}

// ---- Orchestration --------------------------------------------------------------

/** Translates tool arguments to the PATCH body. Only sent keys are changed. */
export function buildCampaignPatch(args: CampaignConfigArgs, existingObjectiveConfig?: unknown): Record<string, unknown> {
  const patch: Record<string, unknown> = compact({
    name: args.name,
    systemPrompt: args.instructions,
    objective: args.objective,
    language: args.language,
    voiceId: args.voice_id,
    scheduledStartAt: args.scheduled_start_at,
    callingWindowStart: args.calling_window_start,
    callingWindowEnd: args.calling_window_end,
    callingDays: args.calling_days,
    respectContactTimezone: args.respect_contact_timezone,
    defaultTimezone: args.timezone,
    maxAttempts: args.max_attempts,
    retryDelayMinutes: args.retry_delay_minutes,
    retryOnDispositions: args.retry_on_dispositions,
    maxConcurrentCalls: args.max_concurrent_calls,
  });

  if (args.shared_variables !== undefined || args.transfer_to !== undefined) {
    // objectiveConfig is replaced wholesale by the API, so merge onto what is there.
    const merged: Record<string, unknown> =
      typeof existingObjectiveConfig === 'object' && existingObjectiveConfig !== null
        ? { ...(existingObjectiveConfig as Record<string, unknown>) }
        : {};

    if (args.shared_variables !== undefined) {
      merged.shared_variables = args.shared_variables;
    }

    if (args.transfer_to !== undefined) {
      merged.transfer_to = args.transfer_to;
    }

    patch.objectiveConfig = merged;
  }

  return patch;
}

/** Applies the three separate config endpoints (agent+schedule, caller ID, outcome fields). */
export async function applyCampaignConfig(
  client: CxCallerClient,
  campaignId: string,
  args: CampaignConfigArgs,
  existingObjectiveConfig?: unknown,
): Promise<void> {
  const patch = buildCampaignPatch(args, existingObjectiveConfig);

  if (Object.keys(patch).length > 0) {
    await client.orgPatch(`/campaigns/${campaignId}`, patch);
  }

  if (args.caller_id) {
    await client.orgPut(`/campaigns/${campaignId}/numbers`, {
      callerIdSource: args.caller_id.source,
      phoneNumberId: args.caller_id.phone_number_id,
    });
  }

  if (args.outcome_fields) {
    await client.orgPut(`/campaigns/${campaignId}/outcome-fields`, {
      fields: args.outcome_fields.map((field) =>
        compact({
          key: field.key,
          label: field.label,
          fieldType: field.type,
          options: field.options,
          isKpi: field.is_kpi,
        }),
      ),
    });
  }
}

export async function attachRecipients(
  client: CxCallerClient,
  campaignId: string,
  sources: RecipientSources,
): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};

  if (sources.recipients?.length) {
    result.imported = await client.orgPost(`/campaigns/${campaignId}/contacts/import`, {
      contacts: sources.recipients.map((recipient) =>
        compact({
          phoneE164: recipient.phone,
          contactName: recipient.name,
          language: recipient.language,
          variables: recipient.variables,
        }),
      ),
    });
  }

  if (sources.group_ids?.length || sources.contact_ids?.length) {
    result.attached = await client.orgPost(
      `/campaigns/${campaignId}/recipients`,
      compact({ groupIds: sources.group_ids, contactIds: sources.contact_ids }),
    );
  }

  return result;
}

interface Page {
  meta?: { itemCount?: number };
}

/**
 * The guardrail that matters: checked at the moment of launch against the real
 * recipient count, so it holds however the recipients got there (a large group,
 * repeated add_campaign_recipients calls, …).
 */
export async function launchWithGuard(
  { client, config }: ToolContext,
  campaignId: string,
): Promise<unknown> {
  const page = await client.orgGet<Page>(`/campaigns/${campaignId}/recipients`, { take: 1 });
  const count = page.meta?.itemCount ?? 0;

  if (count > config.maxRecipients) {
    throw new ToolError(
      `Refusing to launch: the campaign has ${count} recipients, above this server's limit of ${config.maxRecipients} (CXCALLER_MCP_MAX_RECIPIENTS). Nothing was dialed. Remove recipients with a smaller audience, or ask the operator to raise the limit.`,
    );
  }

  return client.orgPost(`/campaigns/${campaignId}/launch`);
}

/** Reports which step of a multi-step tool failed, and what already exists. */
export async function withProgress<T>(
  campaignId: string | undefined,
  step: string,
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (!(error instanceof CxCallerApiError) && !(error instanceof ToolError)) {
      throw error;
    }

    const where = campaignId
      ? ` Campaign ${campaignId} already exists as a draft and nothing has been dialed. Fix the problem and continue with update_campaign / add_campaign_recipients / launch_campaign, or remove it with delete_campaign.`
      : '';

    throw new ToolError(`Failed at "${step}": ${error.message}.${where}`);
  }
}

const idShape = { campaign_id: uuidSchema.describe('Campaign id.') };

// ---- Tools ----------------------------------------------------------------------

export function campaignTools(ctx: ToolContext): AnyToolSpec[] {
  const { client, config } = ctx;
  const recipientLimit = config.maxRecipients;

  return [
    defineTool({
      name: 'list_voices',
      title: 'List voices',
      toolset: 'campaigns',
      mutating: false,
      description: 'Lists the voices an agent can speak with (pass one as voice_id). Exactly one is the default.',
      inputSchema: {},
      handler: () => client.orgGet('/campaigns/voices'),
    }),

    defineTool({
      name: 'list_campaigns',
      title: 'List campaigns',
      toolset: 'campaigns',
      mutating: false,
      description: 'Lists campaigns with their status and headline stats. Filter by lifecycle status or search by name.',
      inputSchema: {
        ...pagingShape,
        query: z.string().optional().describe('Search by name.'),
        status: z.enum(['draft', 'scheduled', 'running', 'paused', 'completed', 'cancelled', 'failed']).optional(),
      },
      handler: ({ page, take, query, status }) => client.orgGet('/campaigns', { page, take, q: query, status }),
    }),

    defineTool({
      name: 'get_campaign',
      title: 'Get campaign',
      toolset: 'campaigns',
      mutating: false,
      description:
        'Full configuration of one campaign (agent, schedule, caller ID, status, stats) plus its declared outcome fields. Status is one of draft, scheduled, running, paused, completed, cancelled, failed.',
      inputSchema: idShape,
      handler: async ({ campaign_id }) => {
        const [campaign, outcomeFields] = await Promise.all([
          client.orgGet<Record<string, unknown>>(`/campaigns/${campaign_id}`),
          client.orgGet(`/campaigns/${campaign_id}/outcome-fields`),
        ]);

        return { ...campaign, outcomeFields };
      },
    }),

    defineTool({
      name: 'create_campaign',
      title: 'Create campaign',
      toolset: 'campaigns',
      mutating: true,
      reachesPeople: true,
      description:
        'Creates a calling campaign in one step: the agent (instructions, language, voice), schedule and pacing, caller ID, the structured data to extract (outcome_fields), and who to call. ' +
        'By default it is created as a DRAFT and nothing is dialed; review it, then run launch_campaign. Pass launch=true to dispatch immediately. ' +
        'A launched campaign starts calling within about 20 seconds, so only launch when the user has asked you to place these calls. ' +
        'Recipients come from `recipients` (phone numbers; contacts are created if new), `group_ids` and/or `contact_ids`. ' +
        'Defaults: each recipient is called once (max_attempts 1) and only one call is in flight at a time (max_concurrent_calls 1), so raise max_concurrent_calls for anything larger than a handful of people.',
      inputSchema: {
        name: z.string().min(1).max(255),
        ...agentShape,
        ...scheduleShape,
        caller_id: callerIdSchema.optional(),
        outcome_fields: outcomeFieldsSchema.optional(),
        recipients: z.array(recipientSchema).max(recipientLimit).optional(),
        group_ids: z.array(uuidSchema).optional(),
        contact_ids: z.array(uuidSchema).optional(),
        launch: z
          .boolean()
          .optional()
          .describe('Dispatch immediately after creating. Default false (leave as a draft for review).'),
      },
      handler: async (args) => {
        const campaign = await withProgress(undefined, 'create campaign', () =>
          client.orgPost<{ id: string }>('/campaigns', { name: args.name }),
        );
        const id = campaign.id;

        // The name was set at creation; do not send it again in the PATCH.
        await withProgress(id, 'configure campaign', () => applyCampaignConfig(client, id, { ...args, name: undefined }));

        const attached = await withProgress(id, 'attach recipients', () => attachRecipients(client, id, args));

        let launched: unknown;

        if (args.launch) {
          launched = await withProgress(id, 'launch', () => launchWithGuard(ctx, id));
        }

        const current = launched ?? (await client.orgGet(`/campaigns/${id}`));

        return {
          campaign: current,
          recipients: attached,
          note: args.launch
            ? 'Launched. It is "scheduled" and starts running within ~20 seconds. Poll get_campaign_stats.'
            : 'Created as a draft; nothing has been dialed. Review it, then call launch_campaign to dispatch.',
        };
      },
    }),

    defineTool({
      name: 'update_campaign',
      title: 'Update campaign',
      toolset: 'campaigns',
      mutating: true,
      idempotent: true,
      description:
        'Edits a campaign. Only draft or scheduled campaigns are editable; a running, paused or finished one is rejected (cancel then reactivate to edit). Send only what should change; omitted fields are untouched and null clears a nullable field. caller_id and outcome_fields replace their current values.',
      inputSchema: {
        ...idShape,
        name: z.string().min(1).max(255).optional(),
        ...agentShape,
        ...scheduleShape,
        caller_id: callerIdSchema.optional(),
        outcome_fields: outcomeFieldsSchema.optional(),
      },
      handler: async ({ campaign_id, ...changes }) => {
        let existing: unknown;

        if (changes.shared_variables !== undefined || changes.transfer_to !== undefined) {
          existing = (await client.orgGet<{ objectiveConfig?: unknown }>(`/campaigns/${campaign_id}`)).objectiveConfig;
        }

        await applyCampaignConfig(client, campaign_id, changes, existing);

        return client.orgGet(`/campaigns/${campaign_id}`);
      },
    }),

    defineTool({
      name: 'add_campaign_recipients',
      title: 'Add campaign recipients',
      toolset: 'campaigns',
      mutating: true,
      description:
        'Adds people to a draft or scheduled campaign, from `recipients` (phone numbers; contacts are created if new), contact groups, and/or existing contacts. Suppressed contacts are skipped and duplicates ignored. A group is copied in at this moment; later changes to the group do not flow in.',
      inputSchema: {
        ...idShape,
        recipients: z.array(recipientSchema).max(recipientLimit).optional(),
        group_ids: z.array(uuidSchema).optional(),
        contact_ids: z.array(uuidSchema).optional(),
      },
      handler: async ({ campaign_id, ...sources }) => {
        if (!sources.recipients?.length && !sources.group_ids?.length && !sources.contact_ids?.length) {
          throw new ToolError('Provide at least one of recipients, group_ids or contact_ids.');
        }

        return attachRecipients(client, campaign_id, sources);
      },
    }),

    defineTool({
      name: 'list_campaign_recipients',
      title: 'List campaign recipients',
      toolset: 'campaigns',
      mutating: false,
      description:
        'Lists who is on a campaign and how far each got. `group` buckets statuses: pending (queued/scheduled), active (dialing/in_progress), done (completed), needs_attention (no_answer/failed/exhausted), skipped (suppressed/cancelled).',
      inputSchema: {
        ...idShape,
        ...pagingShape,
        query: z.string().optional().describe('Search by name or phone.'),
        group: z.enum(['pending', 'active', 'done', 'needs_attention', 'skipped']).optional(),
        status: z
          .enum(['queued', 'scheduled', 'dialing', 'in_progress', 'completed', 'no_answer', 'failed', 'exhausted', 'suppressed', 'cancelled'])
          .optional()
          .describe('Exact status; overrides group.'),
      },
      handler: ({ campaign_id, page, take, query, group, status }) =>
        client.orgGet(`/campaigns/${campaign_id}/recipients`, { page, take, q: query, group, status }),
    }),

    defineTool({
      name: 'retry_campaign_recipient',
      title: 'Retry recipient',
      toolset: 'campaigns',
      mutating: true,
      reachesPeople: true,
      description:
        'Puts a finished recipient (no_answer, failed or exhausted) back in the queue for another attempt. If the campaign is running this leads to another call soon. Use the recipient id from list_campaign_recipients.',
      inputSchema: { ...idShape, recipient_id: uuidSchema },
      handler: ({ campaign_id, recipient_id }) =>
        client.orgPost(`/campaigns/${campaign_id}/recipients/${recipient_id}/retry`),
    }),

    defineTool({
      name: 'launch_campaign',
      title: 'Launch campaign',
      toolset: 'campaigns',
      mutating: true,
      reachesPeople: true,
      description:
        'DISPATCHES a draft campaign: it will start placing real phone calls to every recipient within about 20 seconds (or at its scheduled start). Only call this when the user has asked you to start these calls. ' +
        'The campaign must be complete (recipients, caller ID, and instructions); if not, the error lists what is missing. Use control_campaign to pause or cancel afterwards.',
      inputSchema: idShape,
      handler: ({ campaign_id }) => launchWithGuard(ctx, campaign_id),
    }),

    defineTool({
      name: 'control_campaign',
      title: 'Pause, resume, cancel or reactivate campaign',
      toolset: 'campaigns',
      mutating: true,
      reachesPeople: true,
      description:
        'Moves a campaign through its lifecycle. pause: stop dialing new calls (calls already in progress finish). resume: continue a paused campaign. cancel: stop for good, though a cancelled campaign can be reactivated. reactivate: turn a cancelled campaign back into an editable draft.',
      inputSchema: { ...idShape, action: z.enum(['pause', 'resume', 'cancel', 'reactivate']) },
      handler: ({ campaign_id, action }) => client.orgPost(`/campaigns/${campaign_id}/${action}`),
    }),

    defineTool({
      name: 'delete_campaign',
      title: 'Delete campaign',
      toolset: 'campaigns',
      mutating: true,
      destructive: true,
      description: 'Permanently deletes a draft or cancelled campaign. Campaigns that ran cannot be deleted.',
      inputSchema: idShape,
      handler: async ({ campaign_id }) => {
        await client.orgDelete(`/campaigns/${campaign_id}`);

        return { deleted: campaign_id };
      },
    }),

    defineTool({
      name: 'get_campaign_stats',
      title: 'Get campaign stats',
      toolset: 'campaigns',
      mutating: false,
      description:
        'Live progress of a campaign: recipients (queued/completed/failed), calls made, connect rate, minutes, cost, and a breakdown of how calls ended. Refreshes every ~5 s while running; poll no faster than every 5 s, and stop once status is completed.',
      inputSchema: idShape,
      handler: ({ campaign_id }) => client.orgGet(`/campaigns/${campaign_id}/stats`),
    }),

    defineTool({
      name: 'get_campaign_outcomes',
      title: 'Get campaign outcomes',
      toolset: 'campaigns',
      mutating: false,
      description:
        'What the calls found out: per-field tallies for the outcome_fields declared on the campaign (yes/no counts, numeric summaries, top values). Set include_recipients for the per-person answers, and field_key (+ value) to list who gave a particular answer. Counts are per recipient (their latest answer), not per call.',
      inputSchema: {
        ...idShape,
        include_recipients: z.boolean().optional().describe('Also return per-recipient answers.'),
        field_key: z.string().optional().describe('With include_recipients: only recipients who answered this field.'),
        value: z.string().optional().describe('With field_key: only recipients whose answer equals this (case-insensitive).'),
        ...pagingShape,
      },
      handler: async ({ campaign_id, include_recipients, field_key, value, page, take }) => {
        const summary = await client.orgGet(`/campaigns/${campaign_id}/outcomes`);

        if (!include_recipients) {
          return { summary };
        }

        const recipients = await client.orgGet(`/campaigns/${campaign_id}/outcomes/recipients`, {
          page,
          take,
          fieldKey: field_key,
          value,
        });

        return { summary, recipients };
      },
    }),
  ];
}
