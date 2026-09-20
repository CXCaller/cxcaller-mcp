#!/usr/bin/env node
import { loadConfig } from './config.js';
import { runHttp } from './http.js';
import { SERVER_VERSION } from './server.js';
import { runStdio } from './stdio.js';

const HELP = `cxcaller-mcp ${SERVER_VERSION}: CXCaller MCP server

Usage:
  cxcaller-mcp                    Serve over stdio (for Claude Desktop, Cursor, Claude Code, …)
  cxcaller-mcp --http             Serve over Streamable HTTP at POST /mcp; each client sends its own key
    --port <n>                    Default 3333 (or $PORT)
    --host <addr>                 Default 127.0.0.1. Use 0.0.0.0 only behind TLS.

Environment:
  CXCALLER_API_KEY                API key (required for stdio; optional fallback for HTTP)
  CXCALLER_API_URL                Default https://api.cxcaller.com
  CXCALLER_MCP_READ_ONLY=true     Hide every tool that places calls or changes data
  CXCALLER_MCP_TOOLSETS           Comma list of: account,contacts,campaigns,calls,analytics (default all)
  CXCALLER_MCP_MAX_RECIPIENTS     Largest campaign that may be launched (default 1000)
  CXCALLER_MCP_TIMEOUT_MS         Per-request API timeout (default 30000)
`;

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);

  return index === -1 ? undefined : args[index + 1];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP);

    return;
  }

  if (args.includes('--version') || args.includes('-v')) {
    console.log(SERVER_VERSION);

    return;
  }

  const config = loadConfig();

  if (args.includes('--http')) {
    const port = Number(option(args, '--port') ?? process.env.PORT ?? 3333);

    if (!Number.isInteger(port) || port < 0 || port > 65_535) {
      throw new Error(`Invalid --port "${option(args, '--port') ?? process.env.PORT}"`);
    }

    await runHttp(config, { host: option(args, '--host') ?? '127.0.0.1', port });

    return;
  }

  await runStdio(config);
}

main().catch((error: unknown) => {
  console.error(`[cxcaller-mcp] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
