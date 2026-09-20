import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { buildToolReference } from '../scripts/generate-tool-reference.js';
import { connect } from './helpers.js';

describe('documentation', () => {
  it('docs/tool-reference.md is current (run `pnpm docs:tools` after changing a tool)', () => {
    const committed = readFileSync(new URL('../docs/tool-reference.md', import.meta.url), 'utf8');

    expect(committed).toBe(buildToolReference());
  });

  it('documents every tool the server registers, and no others', async () => {
    const { tools } = await connect({});
    const reference = readFileSync(new URL('../docs/tool-reference.md', import.meta.url), 'utf8');
    const documented = [...reference.matchAll(/^### `([a-z_]+)`$/gm)].map((match) => match[1]);

    expect(documented.sort()).toEqual([...tools].sort());
  });

  it('the usage guide only mentions tools that exist', () => {
    const guide = readFileSync(new URL('../docs/usage-guide.md', import.meta.url), 'utf8');
    const reference = readFileSync(new URL('../docs/tool-reference.md', import.meta.url), 'utf8');
    const known = new Set([...reference.matchAll(/^### `([a-z_]+)`$/gm)].map((match) => match[1]));
    // Tool names are snake_case identifiers in backticks that contain an underscore
    // and are not parameter or field names.
    const mentioned = [...guide.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((match) => match[1] as string);
    const notTools = new Set([
      'max_concurrent_calls', 'max_attempts', 'retry_delay_minutes', 'calling_window_start', 'calling_window_end',
      'calling_days', 'scheduled_start_at', 'transfer_to', 'shared_variables', 'voice_id', 'caller_id', 'wait_seconds',
      'outcome_fields', 'no_answer', 'in_progress', 'needs_attention', 'CXCALLER_API_KEY', 'extracted_data',
      // example outcome-field keys used in the guide's recipes
      'promised_date', 'reference_no',
    ]);
    const unknown = [...new Set(mentioned)].filter((name) => !known.has(name) && !notTools.has(name));

    expect(unknown).toEqual([]);
  });
});
