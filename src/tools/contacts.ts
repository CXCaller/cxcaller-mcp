import { z } from 'zod';

import { defineTool, type AnyToolSpec, type ToolContext } from './define.js';
import { compact, pagingShape, phoneSchema, uuidSchema } from './shared.js';

const contactFields = {
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  email: z.string().email().optional(),
  language: z.string().optional().describe('BCP-47 tag or language name the agent should speak, e.g. "si", "en-US", "Sinhala".'),
  timezone: z.string().optional().describe('IANA name, e.g. "Asia/Colombo". Used to respect calling windows.'),
};

function toContactBody(args: {
  phone?: string;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  language?: string | null;
  timezone?: string | null;
  group_id?: string;
  status?: string;
}) {
  return compact({
    phoneE164: args.phone,
    firstName: args.first_name,
    lastName: args.last_name,
    email: args.email,
    language: args.language,
    timezone: args.timezone,
    groupId: args.group_id,
    status: args.status,
  });
}

export function contactTools({ client, config }: ToolContext): AnyToolSpec[] {
  return [
    defineTool({
      name: 'list_contacts',
      title: 'List contacts',
      toolset: 'contacts',
      mutating: false,
      description:
        'Searches the organization\'s contacts. `query` matches name, phone or email. Filter by status or by contact group.',
      inputSchema: {
        ...pagingShape,
        query: z.string().optional().describe('Free-text search.'),
        status: z.enum(['active', 'inactive', 'blocked']).optional(),
        group_id: uuidSchema.optional().describe('Only contacts in this group.'),
      },
      handler: ({ page, take, query, status, group_id }) =>
        client.orgGet('/contacts', { page, take, q: query, status, groupId: group_id }),
    }),

    defineTool({
      name: 'get_contact',
      title: 'Get contact',
      toolset: 'contacts',
      mutating: false,
      description: 'Fetches one contact by id.',
      inputSchema: { contact_id: uuidSchema },
      handler: ({ contact_id }) => client.orgGet(`/contacts/${contact_id}`),
    }),

    defineTool({
      name: 'create_contact',
      title: 'Create contact',
      toolset: 'contacts',
      mutating: true,
      description:
        'Adds one contact. Does not place a call. A phone number can exist only once per organization, so this fails if it already does; find the existing one with list_contacts instead.',
      inputSchema: {
        phone: phoneSchema,
        ...contactFields,
        group_id: uuidSchema.optional().describe('Also add the contact to this group.'),
      },
      handler: (args) => client.orgPost('/contacts', toContactBody(args)),
    }),

    defineTool({
      name: 'create_contacts_bulk',
      title: 'Create contacts in bulk',
      toolset: 'contacts',
      mutating: true,
      description:
        `Adds many contacts at once (up to ${config.maxRecipients}), optionally into a group. Does not place any calls.`,
      inputSchema: {
        contacts: z
          .array(z.object({ phone: phoneSchema, ...contactFields }))
          .min(1)
          .max(config.maxRecipients),
        group_id: uuidSchema.optional().describe('Add every imported contact to this group.'),
      },
      handler: ({ contacts, group_id }) =>
        client.orgPost('/contacts/bulk', {
          contacts: contacts.map((contact) => toContactBody(contact)),
          groupId: group_id,
        }),
    }),

    defineTool({
      name: 'update_contact',
      title: 'Update contact',
      toolset: 'contacts',
      mutating: true,
      idempotent: true,
      description:
        'Changes a contact. Send only the fields to change; omitted fields are left alone and null clears one. Set status "blocked" to stop all future calls to this person.',
      inputSchema: {
        contact_id: uuidSchema,
        phone: phoneSchema.optional(),
        first_name: z.string().nullable().optional(),
        last_name: z.string().nullable().optional(),
        email: z.string().email().nullable().optional(),
        language: z.string().nullable().optional(),
        timezone: z.string().nullable().optional(),
        status: z.enum(['active', 'inactive', 'blocked']).optional(),
      },
      handler: ({ contact_id, ...rest }) => client.orgPatch(`/contacts/${contact_id}`, toContactBody(rest)),
    }),

    defineTool({
      name: 'delete_contacts',
      title: 'Delete contacts',
      toolset: 'contacts',
      mutating: true,
      destructive: true,
      description:
        'Permanently deletes contacts. To merely stop calling someone, prefer update_contact with status "blocked".',
      inputSchema: { contact_ids: z.array(uuidSchema).min(1).max(config.maxRecipients) },
      handler: ({ contact_ids }) => client.orgPost('/contacts/bulk-delete', { contactIds: contact_ids }),
    }),

    defineTool({
      name: 'list_contact_groups',
      title: 'List contact groups',
      toolset: 'contacts',
      mutating: false,
      description:
        'Lists every contact group (reusable audiences) with its contact count. Not paginated or filterable. Attach a group to a campaign with create_campaign or add_campaign_recipients. To see a group\'s members, use list_contacts with group_id.',
      inputSchema: {},
      handler: () => client.orgGet('/contact-groups'),
    }),

    defineTool({
      name: 'create_contact_group',
      title: 'Create contact group',
      toolset: 'contacts',
      mutating: true,
      description: 'Creates a group, optionally seeded with existing contacts.',
      inputSchema: {
        name: z.string().min(1),
        description: z.string().optional(),
        contact_ids: z.array(uuidSchema).optional(),
      },
      handler: ({ name, description, contact_ids }) =>
        client.orgPost('/contact-groups', compact({ name, description, contactIds: contact_ids })),
    }),

    defineTool({
      name: 'add_contacts_to_group',
      title: 'Add contacts to group',
      toolset: 'contacts',
      mutating: true,
      idempotent: true,
      description: 'Adds existing contacts to a group.',
      inputSchema: {
        group_id: uuidSchema,
        contact_ids: z.array(uuidSchema).min(1).max(config.maxRecipients),
      },
      handler: ({ group_id, contact_ids }) =>
        client.orgPost(`/contact-groups/${group_id}/contacts`, { contactIds: contact_ids }),
    }),
  ];
}
