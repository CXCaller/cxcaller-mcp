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
  /** stdio only. The hosted HTTP server ignores it: every caller must bring their own key. */
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
  /**
   * Longest `make_call` may hold a request open waiting for the call to end.
   * Cloudflare cuts a proxied request at 100 s (a 524), and the call still has
   * setup time before the wait begins, so the default leaves a margin.
   */
  maxWaitSeconds: number;
  /** Hosted (HTTP) mode only. */
  http: HttpConfig;
}

export interface HttpConfig {
  /**
   * Host names the server answers to (e.g. `mcp.cxcaller.com`). Empty = no
   * check beyond the loopback rebinding guard. Health checks are exempt, since
   * the kubelet probes by pod IP.
   */
  allowedHosts: readonly string[];
  /**
   * Take the client address from `CF-Connecting-IP` / `X-Forwarded-For`. Only
   * safe when the origin is reachable solely through a proxy that sets them
   * (a Cloudflare Tunnel does); otherwise a caller could spoof its address.
   */
  trustProxy: boolean;
  /** Requests per minute, per organization (not per key: extra keys buy nothing). */
  requestsPerMinute: number;
  /** In-flight requests per organization. */
  maxConcurrent: number;
  /** Rejected credentials per minute, per client address, before it is blocked. */
  failedAuthPerMinute: number;
  /** How long a SIGTERM waits for in-flight requests (a call may be mid-wait). */
  shutdownGraceMs: number;
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
    maxWaitSeconds: parsePositiveInt('CXCALLER_MCP_MAX_WAIT_SECONDS', env.CXCALLER_MCP_MAX_WAIT_SECONDS, 80),
    http: {
      allowedHosts: (env.CXCALLER_MCP_ALLOWED_HOSTS ?? '')
        .split(',')
        .map((host) => host.trim().toLowerCase())
        .filter(Boolean),
      trustProxy: parseBoolean(env.CXCALLER_MCP_TRUST_PROXY),
      requestsPerMinute: parsePositiveInt('CXCALLER_MCP_RATE_LIMIT_PER_MINUTE', env.CXCALLER_MCP_RATE_LIMIT_PER_MINUTE, 300),
      maxConcurrent: parsePositiveInt('CXCALLER_MCP_MAX_CONCURRENT', env.CXCALLER_MCP_MAX_CONCURRENT, 8),
      failedAuthPerMinute: parsePositiveInt('CXCALLER_MCP_FAILED_AUTH_PER_MINUTE', env.CXCALLER_MCP_FAILED_AUTH_PER_MINUTE, 30),
      shutdownGraceMs: parsePositiveInt('CXCALLER_MCP_SHUTDOWN_GRACE_MS', env.CXCALLER_MCP_SHUTDOWN_GRACE_MS, 100_000),
    },
  };
}
