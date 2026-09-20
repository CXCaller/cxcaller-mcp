import { defineTool, type AnyToolSpec, type ToolContext } from './define.js';
import { periodSchema } from './shared.js';

export function analyticsTools({ client }: ToolContext): AnyToolSpec[] {
  return [
    defineTool({
      name: 'get_analytics_overview',
      title: 'Get analytics overview',
      toolset: 'analytics',
      mutating: false,
      description:
        'Headline numbers for the whole organization over a period: calls, answer rate, talk time, spend, each with its change against the previous period, plus a twelve-month trend. Default period: month.',
      inputSchema: { period: periodSchema },
      handler: ({ period }) => client.orgGet('/analytics/overview', { period }),
    }),

    defineTool({
      name: 'get_analytics_report',
      title: 'Get analytics report',
      toolset: 'analytics',
      mutating: false,
      description:
        'Detailed report over a period: call volume over time, how calls ended (shares that add up), average call time, no-answer rate and answer rate. Default period: week.',
      inputSchema: { period: periodSchema },
      handler: ({ period }) => client.orgGet('/analytics', { period }),
    }),
  ];
}
