export const DEFAULT_API_URL = 'https://api.cxcaller.com';

export const TOOLSETS = [
  'account',
  'contacts',
  'campaigns',
  'calls',
  'analytics',
] as const;

export type Toolset = (typeof TOOLSETS)[number];

export interface Config {
  /** Required for stdio. In HTTP mode each connection brings its own key. */
  apiKey: string | undefined;
  apiUrl: string;
  /** Hide every tool that changes anything or places a call. */
  readOnly: boolean;
  /**
   * Largest campaign an agent may launch. A backstop against an agent
   * dialing an entire database because a group turned out bigger than it
   * assumed — it is checked at the moment of launch, on the real count.
   */
  maxRecipients: number;
  toolsets: ReadonlySet<Toolset>;
  requestTimeoutMs: number;
}

function parseBoolean(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase());
}

function parsePositiveInt(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer, got "${value}"`);
  }

  return parsed;
}

function parseToolsets(value: string | undefined): ReadonlySet<Toolset> {
  if (value === undefined || value.trim() === '') {
    return new Set(TOOLSETS);
  }

  const requested = value
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  const unknown = requested.filter((entry) => !(TOOLSETS as readonly string[]).includes(entry));

  if (unknown.length > 0) {
    throw new Error(
      `CXCALLER_MCP_TOOLSETS has unknown entries: ${unknown.join(', ')}. Valid: ${TOOLSETS.join(', ')}`,
    );
  }

  // `account` carries whoami, which every other tool leans on.
  return new Set<Toolset>(['account', ...(requested as Toolset[])]);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiUrl = (env.CXCALLER_API_URL?.trim() || DEFAULT_API_URL).replace(/\/+$/, '');

  try {
    new URL(apiUrl);
  } catch {
    throw new Error(`CXCALLER_API_URL is not a valid URL: "${apiUrl}"`);
  }

  return {
    apiKey: env.CXCALLER_API_KEY?.trim() || undefined,
    apiUrl,
    readOnly: parseBoolean(env.CXCALLER_MCP_READ_ONLY),
    maxRecipients: parsePositiveInt('CXCALLER_MCP_MAX_RECIPIENTS', env.CXCALLER_MCP_MAX_RECIPIENTS, 1000),
    toolsets: parseToolsets(env.CXCALLER_MCP_TOOLSETS),
    requestTimeoutMs: parsePositiveInt('CXCALLER_MCP_TIMEOUT_MS', env.CXCALLER_MCP_TIMEOUT_MS, 30_000),
  };
}
