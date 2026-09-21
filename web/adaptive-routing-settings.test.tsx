import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "node:test";
import { AdaptiveRoutingSettings } from "./AdaptiveRoutingSettings.tsx";

test("adaptive routing settings expose an explicit Jev toggle and private API-key field", () => {
  const html = renderToStaticMarkup(<AdaptiveRoutingSettings onClose={() => {}} />);
  assert.match(html, /Adaptive routing · Jev/);
  assert.match(html, /Use Jev to choose single-session vs orchestrated execution/);
  assert.match(html, /Fallback when Jev is uncertain or unavailable/);
  assert.match(html, /Orchestrated · safer default/);
  assert.match(html, /TypeSafe API key/);
  assert.match(html, /type="password"/);
  assert.match(html, /When disabled, Hivemind behaves exactly as before/);
  assert.doesNotMatch(html, /value="[^"]*fixture/i);
});
