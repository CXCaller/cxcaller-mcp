import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { CxCallerClient } from './client.js';
import type { Config } from './config.js';
import { registerTools } from './tools/define.js';
import { allTools } from './tools/index.js';

export const SERVER_NAME = 'cxcaller';
export const SERVER_VERSION = '0.1.0';

const INSTRUCTIONS = `CXCaller lets you place real phone calls through an AI voice agent and run calling campaigns.

- One call to one person: make_call, then get_call_result until finished is true.
- Many people: create_campaign (a draft, nothing is dialed), review it with get_campaign, then launch_campaign. Watch it with get_campaign_stats; read answers with get_campaign_outcomes.
- Calls reach real people. Only call numbers the user gave you, only when they asked you to, and never guess a number.
- Declare outcome_fields before calls run if you want structured answers back; they cannot be added to calls that already happened.
- Phone numbers are E.164 ("+94771234567"). Dialing starts within about 20 seconds of a launch.`;

export function createServer(client: CxCallerClient, config: Config): { server: McpServer; tools: string[] } {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: config.readOnly ? `${INSTRUCTIONS}\n\nThis server is READ-ONLY: it cannot place calls or change anything.` : INSTRUCTIONS },
  );
  const tools = registerTools(server, { client, config }, allTools({ client, config }));

  return { server, tools };
}
