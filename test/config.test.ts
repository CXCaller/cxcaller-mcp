import { describe, expect, it } from 'vitest';

import { DEFAULT_API_URL, loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('uses safe defaults', () => {
    const config = loadConfig({});

    expect(config).toMatchObject({
      apiKey: undefined,
      apiUrl: DEFAULT_API_URL,
      readOnly: false,
      maxRecipients: 1000,
      requestTimeoutMs: 30_000,
    });
    expect([...config.toolsets].sort()).toEqual(['account', 'analytics', 'calls', 'campaigns', 'contacts', 'support']);
  });

  it('strips trailing slashes from the API URL', () => {
    expect(loadConfig({ CXCALLER_API_URL: 'https://x.example.com//' }).apiUrl).toBe('https://x.example.com');
  });

  it.each(['1', 'true', 'TRUE', 'yes', 'on'])('reads read-only from "%s"', (value) => {
    expect(loadConfig({ CXCALLER_MCP_READ_ONLY: value }).readOnly).toBe(true);
  });

  it('treats anything else as not read-only', () => {
    expect(loadConfig({ CXCALLER_MCP_READ_ONLY: 'nope' }).readOnly).toBe(false);
  });

  it('always keeps the account toolset, since every tool relies on whoami', () => {
    const config = loadConfig({ CXCALLER_MCP_TOOLSETS: 'calls' });

    expect([...config.toolsets].sort()).toEqual(['account', 'calls']);
  });

  it('rejects an unknown toolset instead of silently dropping it', () => {
    expect(() => loadConfig({ CXCALLER_MCP_TOOLSETS: 'calls,billing' })).toThrow(/billing/);
  });

  it.each(['0', '-3', 'abc', '1.5'])('rejects a bad max-recipients value "%s"', (value) => {
    expect(() => loadConfig({ CXCALLER_MCP_MAX_RECIPIENTS: value })).toThrow(/CXCALLER_MCP_MAX_RECIPIENTS/);
  });

  it('rejects a malformed API URL', () => {
    expect(() => loadConfig({ CXCALLER_API_URL: 'not a url' })).toThrow(/CXCALLER_API_URL/);
  });
});
