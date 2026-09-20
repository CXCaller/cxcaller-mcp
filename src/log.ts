export type Severity = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR';

/**
 * One JSON object per line on stderr. `severity` and `message` are the fields
 * Cloud Logging maps to level and text, so GKE shows these correctly (without
 * them every stderr line would be ERROR).
 *
 * Never pass an API key, a request body, or tool arguments here: those hold
 * tenants' credentials and callers' personal data.
 */
export function logEvent(severity: Severity, message: string, fields: Record<string, unknown> = {}): void {
  process.stderr.write(`${JSON.stringify({ severity, message, time: new Date().toISOString(), ...fields })}\n`);
}
