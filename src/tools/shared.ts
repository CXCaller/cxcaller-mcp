import { z } from 'zod';

/** E.164: a "+", a non-zero country digit, up to 15 digits in all. */
export const E164 = /^\+[1-9]\d{6,14}$/;

export const phoneSchema = z
  .string()
  .regex(E164, 'Use E.164 format: "+" then country code and number, no spaces (e.g. +94771234567)');

export const uuidSchema = z.string().uuid();

export const pagingShape = {
  page: z.number().int().min(1).optional().describe('1-based page number. Default 1.'),
  take: z.number().int().min(1).max(50).optional().describe('Items per page, 1–50. Default 10.'),
};

export const periodSchema = z
  .enum(['day', 'week', 'month', 'quarter', 'year'])
  .optional()
  .describe('Window to report on. Compared against the equal-length window before it.');

export const callerIdSchema = z
  .object({
    source: z
      .enum(['shared_pool', 'dedicated'])
      .describe(
        '"shared_pool": the dialer picks the least busy pool number per call (default, included with any plan). "dedicated": pin one number this organization has claimed.',
      ),
    phone_number_id: uuidSchema
      .optional()
      .describe('Required for "dedicated", forbidden for "shared_pool". Get ids from list_caller_ids.'),
  })
  .describe('Which number the calls come from.');

export const outcomeFieldsSchema = z
  .array(
    z.object({
      key: z.string().min(1).max(100).describe('Machine key, e.g. "paid" or "callback_date".'),
      label: z.string().min(1).max(255).describe('Human label, e.g. "Paid?".'),
      type: z.enum(['text', 'number', 'boolean', 'enum', 'json']),
      options: z.array(z.string()).optional().describe('Allowed values; only for type "enum".'),
      is_kpi: z.boolean().optional().describe('Highlight as a headline KPI on the campaign overview.'),
    }),
  )
  .describe(
    'What to extract from each conversation. Declare these BEFORE calls run: without them results only contain a free-text summary, no structured answers. A field the caller never answered comes back null.',
  );

/** Drops `undefined` so absent keys stay absent in a PATCH body ("omitted" ≠ "cleared"). */
export function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}

export function pageQuery(args: { page?: number; take?: number; query?: string }): Record<string, string | number | undefined> {
  return { page: args.page, take: args.take, q: args.query };
}
