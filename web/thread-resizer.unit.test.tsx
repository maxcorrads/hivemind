import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Window } from "happy-dom";
import React, { act } from "react";
import { THREAD_WIDTH_KEY } from "./thread-resize.ts";

const window = new Window({ url: "http://localhost/", width: 1600 });
Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
const { ThreadResizer } = await import("./ThreadResizer.tsx");
after(() => window.happyDOM.close());

test("a thread mounted with its shell applies its saved width and measures pane bounds", async t => {
  window.localStorage.setItem(THREAD_WIDTH_KEY, "572");
  t.mock.method(window.HTMLElement.prototype, "getBoundingClientRect", function (this: HTMLElement) {
    const left = this.classList.contains("desk") ? 324 : 0;
    return new window.DOMRect(left, 0, 1600 - left, 900);
  });
  function Shell() {
    return <div className="shell"><main className="desk" /><ThreadResizer /></div>;
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Shell />));
    const shell = host.querySelector<HTMLElement>(".shell")!;
    assert.equal(shell.style.getPropertyValue("--thread-w"), "572px");
    assert.equal(host.querySelector('[role="separator"]')?.getAttribute("aria-valuemax"), "968");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
