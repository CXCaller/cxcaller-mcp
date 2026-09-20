import { accountTools } from './account.js';
import { analyticsTools } from './analytics.js';
import { callTools } from './calls.js';
import { campaignTools } from './campaigns.js';
import { contactTools } from './contacts.js';
import type { AnyToolSpec, ToolContext } from './define.js';

export function allTools(ctx: ToolContext): AnyToolSpec[] {
  return [
    ...accountTools(ctx),
    ...contactTools(ctx),
    ...campaignTools(ctx),
    ...callTools(ctx),
    ...analyticsTools(ctx),
  ];
}
