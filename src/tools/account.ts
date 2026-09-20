import { z } from 'zod';

import { defineTool, type AnyToolSpec, type ToolContext } from './define.js';
import { pagingShape } from './shared.js';

export function accountTools({ client }: ToolContext): AnyToolSpec[] {
  return [
    defineTool({
      name: 'get_account',
      title: 'Get account',
      toolset: 'account',
      mutating: false,
      description:
        'Shows which CXCaller organization this API key is bound to (id, name, default timezone) and the key\'s own name. Every other tool already targets this organization automatically; call this to confirm you are connected to the right account.',
      inputSchema: {},
      handler: () => client.whoami(),
    }),

    defineTool({
      name: 'list_caller_ids',
      title: 'List caller IDs',
      toolset: 'account',
      mutating: false,
      description:
        'Lists the phone numbers calls can come from: the shared pool (available to every account; use caller_id.source "shared_pool" and the dialer picks one per call) and the organization\'s own claimed dedicated numbers (pin one with source "dedicated" and its id). Numbers cannot be claimed or released with an API key.',
      inputSchema: {
        ...pagingShape,
        include: z
          .enum(['both', 'dedicated', 'pool'])
          .optional()
          .describe('Which list to return. Default "both".'),
      },
      handler: async ({ include = 'both', page, take }) => {
        const query = { page, take };
        const [dedicated, pool] = await Promise.all([
          include === 'pool' ? undefined : client.orgGet('/phone-numbers', query),
          include === 'dedicated' ? undefined : client.orgGet('/phone-numbers/pool', query),
        ]);

        return { dedicated, sharedPool: pool };
      },
    }),
  ];
}
