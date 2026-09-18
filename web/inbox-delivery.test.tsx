import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { InboxReceipt, QueueBadge } from "./InboxReceipt.tsx";

test("queue badge distinguishes exact, lower-bound and unknown counts", () => {
  assert.equal(renderToStaticMarkup(<QueueBadge estimate={{ atLeast: 0, exact: true }} />), "");
  assert.match(renderToStaticMarkup(<QueueBadge estimate={{ atLeast: 3, exact: true }} />), />3</);
  assert.match(renderToStaticMarkup(<QueueBadge estimate={{ atLeast: 3, exact: false }} />), />3\+</);
  const unknown = renderToStaticMarkup(<QueueBadge estimate={{ atLeast: 0, exact: false }} />);
  assert.match(unknown, /Queue size unknown/);
  assert.match(unknown, />…</);
  assert.match(renderToStaticMarkup(<QueueBadge count={2} />), />2</);
});

test("receipt UI distinguishes offered mail from confirmed receipt and never claims task completion", () => {
  const html = renderToStaticMarkup(<InboxReceipt status={{ awaitingReceipt: 2, acknowledgedMessages: 5, lastAcknowledgedAt: 10 }} />);
  assert.match(html, /Receipt pending: 2/); assert.match(html, /Received: 5/);
  assert.match(html, /does not mean the tasks were accepted, completed or reviewed/);
  assert.match(html, /Retained for redelivery/);
  assert.equal(renderToStaticMarkup(<InboxReceipt />), "");
  assert.doesNotMatch(renderToStaticMarkup(<InboxReceipt status={{ awaitingReceipt: 0, acknowledgedMessages: 5, lastAcknowledgedAt: 10 }} />), /Receipt pending/);
});
