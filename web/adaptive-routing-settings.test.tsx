import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "node:test";
import { AdaptiveRoutingSettings } from "./AdaptiveRoutingSettings.tsx";

test("adaptive routing settings keep provider scope and fallback information available", () => {
  const html = renderToStaticMarkup(<AdaptiveRoutingSettings onClose={() => {}} />);
  assert.match(html, /Enable adaptive routing/);
  assert.match(html, /Initial fallback when Jev is uncertain or unavailable/);
  assert.match(html, /Orchestrated topology fallback/);
  assert.match(html, /type="password"/);
  assert.match(html, /What data is sent to Jev/);
  assert.match(html, /Repository contents, full message history and Hivemind credentials are not sent/);
  assert.match(html, /Existing work keeps its current team/);
  assert.doesNotMatch(html, /value="[^"]*fixture/i);
});
