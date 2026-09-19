/** Health revisions survive server restart and prevent a late HTTP snapshot undoing a live warning. */
export type TelegramHealth = {
  revision?: number; failures?: number; diagnosticsPruned?: number;
  lastSuccessAt?: number | null; lastError?: string | null;
  quarantined?: number; retrying?: number; inboundDiagnosticsPruned?: number;
};
const fields = ["revision", "failures", "diagnosticsPruned", "lastSuccessAt", "lastError", "quarantined", "retrying", "inboundDiagnosticsPruned"] as const;
export function newerTelegramHealth(current: TelegramHealth | null | undefined, incoming: TelegramHealth | null | undefined): TelegramHealth {
  const chosen = (current?.revision ?? 0) > (incoming?.revision ?? 0) ? current : incoming ?? current;
  return Object.fromEntries(fields.filter(key => chosen?.[key] !== undefined).map(key => [key, chosen![key]]));
}
export function telegramDegraded(health?: TelegramHealth): boolean {
  return Boolean(health?.failures || health?.quarantined || health?.retrying || health?.lastError);
}
