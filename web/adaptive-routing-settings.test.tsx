import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "node:test";
import { AdaptiveRoutingSettings } from "./AdaptiveRoutingSettings.tsx";

test("Jev settings keep provider scope information and say that advice is never enforced (#211)", () => {
  const html = renderToStaticMarkup(<AdaptiveRoutingSettings onClose={() => {}} />);
  assert.match(html, /Enable Jev advice/);
  assert.match(html, /Its advice is never enforced: the brain decides, and your instructions always take precedence/);
  assert.doesNotMatch(html, /fallback|Orchestrated|Manual routing/i);
  assert.match(html, /type="password"/);
  assert.match(html, /What data is sent to Jev/);
  assert.match(html, /Repository contents, full message history and Hivemind credentials are not sent/);
  assert.match(html, /the brain is told so and simply decides without advice/);
  assert.doesNotMatch(html, /value="[^"]*fixture/i);
});
