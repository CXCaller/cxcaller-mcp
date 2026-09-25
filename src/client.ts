/** An array value is sent as a repeated parameter (`?status=a&status=b`). */
export type Query = Record<string, string | number | boolean | readonly string[] | undefined | null>;

export interface RequestOptions {
  query?: Query;
  body?: unknown;
}

export interface Identity {
  organizationId: string;
  organizationName: string;
  defaultTimezone: string;
  apiKeyId: string;
  apiKeyName: string | null;
  apiKeyPrefix: string;
}

/** Lets an HTTP host share whoami lookups across the per-request clients it builds. */
export interface IdentityCache {
  get(apiKey: string): Identity | undefined;
  set(apiKey: string, identity: Identity): void;
}

export interface ClientOptions {
  apiKey: string;
  baseUrl: string;
  timeoutMs?: number;
  identityCache?: IdentityCache;
  fetch?: typeof fetch;
}

/**
 * What an agent should do about the API's machine-readable error codes. The
 * codes are `error.*` keys meant for i18n, which read poorly in a tool result.
 */
const HINTS: Record<string, string> = {
  'error.campaign_incomplete':
    'The campaign cannot launch yet. Fix everything in `missing` (recipients, caller_id, agent) and retry. `verification` means the platform\'s content review has not approved it: run verify_campaign.',
  'error.campaign_not_editable':
    'Only draft or scheduled campaigns can be edited. Cancel then reactivate it to get back to draft.',
  'error.campaign_not_launchable': 'Only a draft campaign can be launched.',
  'error.campaign_invalid_transition':
    'That action is not valid for the campaign\'s current status. Read the campaign\'s status and follow the lifecycle: draft → scheduled → running ⇄ paused → completed; cancelled → reactivate → draft.',
  'error.campaign_not_deletable':
    'Only draft, cancelled, completed or failed campaigns can be deleted. Cancel a scheduled, running or paused one first (control_campaign).',
  'error.campaign_caller_id_invalid':
    'Use caller_id.source "shared_pool" with no number, or "dedicated" with a phone_number_id this organization has claimed.',
  'error.campaign_recipients_source_required': 'Provide at least one of group_ids / contact_ids.',
  'error.campaign_outcome_field_key_duplicate': 'Outcome field keys must be unique.',
  'error.campaign_recipient_not_retryable':
    'Only recipients that are no_answer, failed or exhausted can be retried.',
  'error.contact_phone_already_exists':
    'A contact with this phone number already exists. Find it with list_contacts instead of creating it again.',
  'error.api_key_not_permitted':
    'API keys cannot use this endpoint. This is intentional; it is not a temporary error.',
  'error.not_organization_member': 'This API key belongs to a different organization.',
};

export class CxCallerApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'CxCallerApiError';
  }
}

function describeFailure(status: number, body: unknown): { code?: string; message: string } {
  const payload = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const rawMessage = payload.message;
  const code = typeof rawMessage === 'string' ? rawMessage : undefined;
  let message: string;

  if (Array.isArray(rawMessage)) {
    message = rawMessage.map(String).join('; ');
  } else if (typeof rawMessage === 'string') {
    message = rawMessage;
  } else {
    message = typeof payload.error === 'string' ? payload.error : `HTTP ${status}`;
  }

  if (Array.isArray(payload.missing)) {
    message += ` (missing: ${payload.missing.map(String).join(', ')})`;
  }

  const hint = code ? HINTS[code] : undefined;

  return { code, message: hint ? `${message}. ${hint}` : message };
}

const RETRYABLE_STATUSES = new Set([502, 503, 504]);
const MAX_GET_RETRIES = 2;
const MAX_RETRY_AFTER_MS = 5000;

function isTransient(error: CxCallerApiError): boolean {
  return error.code === 'network' || error.status === 429 || RETRYABLE_STATUSES.has(error.status);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class CxCallerClient {
  private readonly fetchImpl: typeof fetch;

  private identity: Identity | undefined;

  constructor(private readonly options: ClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  get<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>('GET', path, options);
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, { body });
  }

  put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PUT', path, { body });
  }

  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PATCH', path, { body });
  }

  delete<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('DELETE', path, { body });
  }

  /** Which organization this key is bound to. The path of every other route needs it. */
  async whoami(): Promise<Identity> {
    if (this.identity) {
      return this.identity;
    }

    const cached = this.options.identityCache?.get(this.options.apiKey);

    if (cached) {
      this.identity = cached;

      return cached;
    }

    const fresh = await this.request<Identity>('GET', '/api-key/whoami');

    this.identity = fresh;
    this.options.identityCache?.set(this.options.apiKey, fresh);

    return fresh;
  }

  /** Requests under `/organizations/:id/…` for the key's own organization. */
  async org<T>(
    method: string,
    subpath: string,
    options?: RequestOptions,
  ): Promise<T> {
    const { organizationId } = await this.whoami();

    return this.request<T>(method, `/organizations/${organizationId}${subpath}`, options);
  }

  orgGet<T>(subpath: string, query?: Query): Promise<T> {
    return this.org<T>('GET', subpath, { query });
  }

  orgPost<T>(subpath: string, body?: unknown): Promise<T> {
    return this.org<T>('POST', subpath, { body });
  }

  orgPut<T>(subpath: string, body?: unknown): Promise<T> {
    return this.org<T>('PUT', subpath, { body });
  }

  orgPatch<T>(subpath: string, body?: unknown): Promise<T> {
    return this.org<T>('PATCH', subpath, { body });
  }

  orgDelete<T>(subpath: string, body?: unknown): Promise<T> {
    return this.org<T>('DELETE', subpath, { body });
  }

  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const url = new URL(this.options.baseUrl + path);

    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (Array.isArray(value)) {
        for (const entry of value) {
          url.searchParams.append(key, entry);
        }
      } else if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }

    // Only reads are retried: repeating a POST could place a second call.
    const attempts = method === 'GET' ? MAX_GET_RETRIES + 1 : 1;
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await this.send<T>(method, url, options.body);
      } catch (error) {
        lastError = error;

        if (attempt === attempts || !(error instanceof CxCallerApiError) || !isTransient(error)) {
          throw error;
        }

        // A timeout is not retried: three of them would hold the agent for 90 s.
        const delay =
          error.status === 429
            ? Math.min(Number(error.details) * 1000 || 1000, MAX_RETRY_AFTER_MS)
            : 250 * attempt;

        await sleep(delay);
      }
    }

    throw lastError;
  }

  private async send<T>(method: string, url: URL, body: unknown): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.options.apiKey}`,
      Accept: 'application/json',
      'User-Agent': 'cxcaller-mcp',
    };

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    let response: Response;

    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
      });
    } catch (error) {
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        throw new CxCallerApiError(0, 'timeout', `Request to ${method} ${url.pathname} timed out`);
      }

      throw new CxCallerApiError(
        0,
        'network',
        `Could not reach the CXCaller API at ${url.origin}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const text = await response.text();
    let parsed: unknown;

    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!response.ok) {
      if (response.status === 401) {
        throw new CxCallerApiError(
          401,
          'unauthorized',
          'The CXCaller API rejected the API key (missing, invalid, or revoked). Create a new key in the CXCaller dashboard.',
        );
      }

      const { code, message } = describeFailure(response.status, parsed);

      throw new CxCallerApiError(
        response.status,
        code,
        `${response.status} ${message}`,
        response.status === 429 ? response.headers.get('retry-after') : parsed,
      );
    }

    return parsed as T;
  }
}
