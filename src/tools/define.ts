import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';

import type { CxCallerClient } from '../client.js';
import { CxCallerApiError } from '../client.js';
import type { Config, Toolset } from '../config.js';

export interface ToolContext {
  client: CxCallerClient;
  config: Config;
}

/** A failure the agent should read and can act on, as opposed to a bug. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

export interface ToolSpec<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  toolset: Toolset;
  /** Changes state or places a call. Hidden entirely in read-only mode. */
  mutating: boolean;
  /** Removes or irreversibly stops something. Surfaced to clients as a hint. */
  destructive?: boolean;
  /** Reaches a real person over the phone. */
  reachesPeople?: boolean;
  idempotent?: boolean;
  inputSchema: Shape;
  handler: (args: z.infer<z.ZodObject<Shape>>) => Promise<unknown>;
}

// Erases the per-tool argument type so specs of different shapes share one list.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolSpec = ToolSpec<any>;

export function defineTool<Shape extends z.ZodRawShape>(spec: ToolSpec<Shape>): AnyToolSpec {
  return spec;
}

const MAX_RESULT_CHARS = 80_000;

export function toResult(data: unknown): CallToolResult {
  let text = data === undefined ? 'OK' : JSON.stringify(data);

  if (text.length > MAX_RESULT_CHARS) {
    text =
      text.slice(0, MAX_RESULT_CHARS) +
      `\n…[truncated ${text.length - MAX_RESULT_CHARS} characters. Narrow the request with filters or a smaller "take".]`;
  }

  return { content: [{ type: 'text', text }] };
}

export function toErrorResult(error: unknown): CallToolResult {
  let message: string;

  if (error instanceof ToolError || error instanceof CxCallerApiError) {
    message = error.message;
  } else if (error instanceof Error) {
    message = `Unexpected error: ${error.message}`;
  } else {
    message = `Unexpected error: ${String(error)}`;
  }

  return { isError: true, content: [{ type: 'text', text: message }] };
}

export function registerTools(server: McpServer, ctx: ToolContext, specs: AnyToolSpec[]): string[] {
  const registered: string[] = [];

  for (const spec of specs) {
    if (!ctx.config.toolsets.has(spec.toolset)) {
      continue;
    }

    if (ctx.config.readOnly && spec.mutating) {
      continue;
    }

    server.registerTool(
      spec.name,
      {
        title: spec.title,
        description: spec.description,
        inputSchema: spec.inputSchema,
        annotations: {
          title: spec.title,
          readOnlyHint: !spec.mutating,
          destructiveHint: spec.mutating ? (spec.destructive ?? false) : false,
          idempotentHint: spec.idempotent ?? !spec.mutating,
          openWorldHint: spec.reachesPeople ?? false,
        },
      },
      async (args: Record<string, unknown>): Promise<CallToolResult> => {
        try {
          return toResult(await spec.handler(args));
        } catch (error) {
          return toErrorResult(error);
        }
      },
    );

    registered.push(spec.name);
  }

  return registered;
}
