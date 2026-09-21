import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "node:test";
import { AdaptiveRoutingSettings } from "./AdaptiveRoutingSettings.tsx";

test("adaptive routing settings expose the opt-in Jev toggle, topology fallback and private key field", () => {
  const html = renderToStaticMarkup(<AdaptiveRoutingSettings onClose={() => {}} />);
  assert.match(html, /Adaptive routing · Jev/);
  assert.match(html, /Use Jev for continuous execution-topology routing/);
  assert.match(html, /Fallback when Jev is uncertain or unavailable/);
  assert.match(html, /Orchestrated topology fallback/);
  assert.match(html, /Brain \+ 1 · lowest coordination overhead/);
  assert.match(html, /Orchestrated · safer default/);
  assert.match(html, /TypeSafe API key/);
  assert.match(html, /type="password"/);
  assert.match(html, /When disabled, Auto behaves exactly as legacy Hivemind/);
  assert.match(html, /Jev failure preserves the current topology/);
  assert.match(html, /Human-only warning/);
  assert.match(html, /Auto · Jev \/ Single \/ Brain \+ 1 \/ Multi-DM \/ Room \/ Orchestrated Auto/);
  assert.match(html, /task\/conversation/);
  assert.doesNotMatch(html, /value="[^"]*fixture/i);
});
