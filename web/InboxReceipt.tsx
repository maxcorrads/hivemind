import type { InboxStatus } from "../src/shared/types.ts";

export function InboxReceipt({ status }: { status?: InboxStatus }) {
  if (!status) return null;
  return <span className="inbox-receipt">
    {status.awaitingReceipt > 0 && <span title="Offered to the client, not yet confirmed. Retained for redelivery.">Receipt pending: {status.awaitingReceipt}</span>}
    {status.acknowledgedMessages > 0 && <span title="Confirmed received. This does not mean the tasks were accepted, completed or reviewed.">Received: {status.acknowledgedMessages}</span>}
  </span>;
}
