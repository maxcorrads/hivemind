import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { InboxReceipt } from "./InboxReceipt.tsx";

test("receipt UI distinguishes offered mail from confirmed receipt and never claims task completion", () => {
  const html = renderToStaticMarkup(<InboxReceipt status={{ awaitingReceipt: 2, acknowledgedMessages: 5, lastAcknowledgedAt: 10 }} />);
  assert.match(html, /Receipt pending: 2/); assert.match(html, /Received: 5/);
  assert.match(html, /does not mean the tasks were accepted, completed or reviewed/);
  assert.match(html, /Retained for redelivery/);
  assert.equal(renderToStaticMarkup(<InboxReceipt />), "");
  assert.doesNotMatch(renderToStaticMarkup(<InboxReceipt status={{ awaitingReceipt: 0, acknowledgedMessages: 5, lastAcknowledgedAt: 10 }} />), /Receipt pending/);
});
