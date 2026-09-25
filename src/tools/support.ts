import { z } from 'zod';

import { defineTool, type AnyToolSpec, type ToolContext } from './define.js';
import { compact, pagingShape, uuidSchema } from './shared.js';

const ticketIdShape = { ticket_id: uuidSchema.describe('Ticket id (not the "CX-1001" reference).') };

const statusSchema = z.enum(['open', 'in_progress', 'waiting_on_you', 'resolved']);

export function supportTools({ client }: ToolContext): AnyToolSpec[] {
  return [
    defineTool({
      name: 'list_support_tickets',
      title: 'List support tickets',
      toolset: 'support',
      mutating: false,
      description:
        'Lists the organization\'s CXCaller support tickets, most recently active first, each with its reference (e.g. CX-1001), subject, status and last message. ' +
        'Status: open (waiting for support), in_progress (support is on it), waiting_on_you (support replied and needs an answer), resolved. ' +
        'hasUnreadUpdate is true when support has the last word.',
      inputSchema: {
        ...pagingShape,
        query: z.string().optional().describe('Search by reference or subject.'),
        status: z.array(statusSchema).optional().describe('Only tickets in these statuses.'),
      },
      handler: ({ page, take, query, status }) => client.orgGet('/support/tickets', { page, take, q: query, status }),
    }),

    defineTool({
      name: 'get_support_ticket',
      title: 'Get support ticket',
      toolset: 'support',
      mutating: false,
      description: 'One support ticket with its full conversation (messages from the organization and from CXCaller support) and status history.',
      inputSchema: ticketIdShape,
      handler: ({ ticket_id }) => client.orgGet(`/support/tickets/${ticket_id}`),
    }),

    defineTool({
      name: 'create_support_ticket',
      title: 'Open support ticket',
      toolset: 'support',
      mutating: true,
      description:
        'Opens a ticket with CXCaller support, which is emailed about it. Use it for problems the user wants CXCaller staff to look at (failing calls, billing, numbers, account). ' +
        'It is written under this API key\'s name and is visible to everyone in the organization\'s Help Center. Include ids (campaign, call) and what was expected vs. what happened. Limited to 10 per hour per organization.',
      inputSchema: {
        subject: z.string().min(1).max(200),
        category: z.enum(['campaigns', 'phone_numbers', 'contacts', 'billing', 'account', 'other']),
        priority: z.enum(['low', 'normal', 'high', 'urgent']).optional().describe('Default normal.'),
        description: z.string().min(1).max(10_000).describe('The first message: the problem in full.'),
      },
      handler: (args) => client.orgPost('/support/tickets', compact(args)),
    }),

    defineTool({
      name: 'reply_to_support_ticket',
      title: 'Reply to support ticket',
      toolset: 'support',
      mutating: true,
      description:
        'Adds a message to a ticket, written under this API key\'s name. Replying to a resolved or waiting_on_you ticket reopens it (status open).',
      inputSchema: {
        ...ticketIdShape,
        body: z.string().min(1).max(10_000),
      },
      handler: ({ ticket_id, body }) => client.orgPost(`/support/tickets/${ticket_id}/messages`, { body }),
    }),

    defineTool({
      name: 'set_support_ticket_status',
      title: 'Resolve or reopen support ticket',
      toolset: 'support',
      mutating: true,
      idempotent: true,
      description: 'Marks a ticket resolved, or reopens it. Only CXCaller support can set the other statuses.',
      inputSchema: {
        ...ticketIdShape,
        status: z.enum(['open', 'resolved']),
      },
      handler: ({ ticket_id, status }) => client.orgPatch(`/support/tickets/${ticket_id}/status`, { status }),
    }),

    defineTool({
      name: 'get_support_attachment_url',
      title: 'Get support attachment URL',
      toolset: 'support',
      mutating: false,
      description: 'A short-lived download URL for a file attached to a ticket message (ids from get_support_ticket). It expires at expiresAt.',
      inputSchema: {
        ...ticketIdShape,
        attachment_id: uuidSchema,
      },
      handler: ({ ticket_id, attachment_id }) => client.orgGet(`/support/tickets/${ticket_id}/attachments/${attachment_id}`),
    }),

    defineTool({
      name: 'get_support_chat',
      title: 'Read support chat',
      toolset: 'support',
      mutating: false,
      description:
        'The organization\'s live chat with CXCaller support (one thread per organization), oldest first. Without `after`: the latest 200 messages. ' +
        'To wait for an answer, poll every 10 s or so with `after` set to the newest createdAt you have; it returns only newer messages. Author is user, support, or automated (the canned acknowledgement).',
      inputSchema: {
        after: z.string().datetime({ offset: true }).optional().describe('Only messages strictly after this ISO 8601 instant.'),
      },
      handler: ({ after }) => client.orgGet('/support/chat/messages', { after }),
    }),

    defineTool({
      name: 'send_support_chat_message',
      title: 'Send support chat message',
      toolset: 'support',
      mutating: true,
      description:
        'Sends a message to CXCaller support\'s live chat, written under this API key\'s name. The first message after 24 h of silence also gets an automated acknowledgement, returned alongside it. ' +
        'Staff answer when they are online; read replies with get_support_chat. For anything that needs tracking, prefer create_support_ticket.',
      inputSchema: { body: z.string().min(1).max(4000) },
      handler: ({ body }) => client.orgPost('/support/chat/messages', { body }),
    }),
  ];
}
