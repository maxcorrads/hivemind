/** Human-only connection diagnostics. Never include provider text or key-derived identifiers. */
export const JEV_DIAGNOSTIC_MESSAGES = {
  success: 'Jev accepted the saved key and returned a valid synthetic response. This does not validate routing quality.',
  missing_key: 'No TypeSafe API key is saved. Save a key before testing.',
  authorization_failed: 'TypeSafe rejected the saved credentials or their permissions.',
  rate_limited: 'TypeSafe rate-limited the test. No retry was made.',
  timeout: 'The connection test timed out. No retry was made.',
  network_error: 'The connection could not be completed. Check network access to TypeSafe.',
  provider_error: 'TypeSafe could not process the test. No retry was made.',
  invalid_contract: 'TypeSafe returned an invalid or oversized test response.',
  cancelled: 'Connection test cancelled. A request already sent may still consume provider usage.',
  settings_changed: 'Saved settings changed. Discard this result and test the saved configuration again.',
  busy: 'Another connection test is in progress. No additional request was sent.',
} as const;
export type JevDiagnosticCode = keyof typeof JEV_DIAGNOSTIC_MESSAGES;
export type JevDiagnosticState = { revision: string; apiKeySet: boolean };
export type JevDiagnosticResult = { revision: string; code: JevDiagnosticCode };
