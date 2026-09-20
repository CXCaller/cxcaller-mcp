import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { CxCallerApiError, CxCallerClient } from './client.js';
import type { Config } from './config.js';
import { createServer } from './server.js';

/** stdout carries the protocol; anything human-readable goes to stderr. */
function log(message: string): void {
  console.error(`[cxcaller-mcp] ${message}`);
}

export async function runStdio(config: Config): Promise<void> {
  if (!config.apiKey) {
    throw new Error(
      'CXCALLER_API_KEY is not set. Create an API key in the CXCaller dashboard and pass it in the environment of this MCP server.',
    );
  }

  const client = new CxCallerClient({
    apiKey: config.apiKey,
    baseUrl: config.apiUrl,
    timeoutMs: config.requestTimeoutMs,
  });

  // Fail fast on a definitively bad key; tolerate the API being briefly unreachable.
  try {
    const identity = await client.whoami();

    log(`connected to "${identity.organizationName}" with key ${identity.apiKeyPrefix}…`);
  } catch (error) {
    if (error instanceof CxCallerApiError && error.status === 401) {
      throw error;
    }

    log(`could not verify the API key yet (${error instanceof Error ? error.message : String(error)}); continuing`);
  }

  const { server, tools } = createServer(client, config);

  await server.connect(new StdioServerTransport());
  log(`ready on stdio with ${tools.length} tools${config.readOnly ? ' (read-only)' : ''}`);
}
