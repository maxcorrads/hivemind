import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { Window } from "happy-dom";
import { act } from "react";
import { Modal } from "./Modal.tsx";

const window = new Window({ url: "http://localhost/" });
Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement,
  HTMLSelectElement: window.HTMLSelectElement, IS_REACT_ACT_ENVIRONMENT: true });
// happy-dom has no layout; treat every element as rendered so the focus trap sees it.
window.HTMLElement.prototype.getClientRects = function () { return [{}] as unknown as DOMRectList; } as never;
const { createRoot } = await import("react-dom/client");
after(() => window.happyDOM.close());

let unmounts: Array<() => void> = [];
afterEach(() => {
  for (const unmount of unmounts.reverse()) unmount();
  unmounts = [];
  document.body.innerHTML = "";
});

async function mount(node: React.ReactNode) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  await act(async () => root.render(node));
  let mounted = true;
  const unmount = () => { if (mounted) { mounted = false; act(() => root.unmount()); } };
  unmounts.push(unmount);
  return { host, unmount };
}

function key(init: { key: string; shiftKey?: boolean }, target: EventTarget = document.activeElement ?? document.body) {
  const event = new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event as unknown as Event);
  return event;
}

const active = () => (document.activeElement as HTMLElement | null)?.dataset.id ?? document.activeElement?.className;

test("focuses the first control, traps Tab in both directions and restores focus on close", async () => {
  const opener = document.createElement("button");
  opener.dataset.id = "opener";
  document.body.appendChild(opener);
  opener.focus();
  const { unmount } = await mount(<Modal>
    <button data-id="first">A</button><button disabled>skip</button><input type="hidden" /><button data-id="last">B</button>
  </Modal>);
  assert.equal(active(), "first");
  assert.equal(key({ key: "Tab", shiftKey: true }).defaultPrevented, true);
  assert.equal(active(), "last");
  assert.equal(key({ key: "Tab" }).defaultPrevented, true);
  assert.equal(active(), "first");
  assert.equal(key({ key: "Tab" }).defaultPrevented, false, "Tab inside the sheet uses native order");
  opener.focus();
  assert.equal(key({ key: "Tab" }, opener).defaultPrevented, true);
  assert.equal(active(), "first");
  opener.focus();
  key({ key: "Tab", shiftKey: true }, opener);
  assert.equal(active(), "last");
  unmount();
  assert.equal(active(), "opener");
});

test("a sheet without controls keeps focus on itself", async () => {
  await mount(<Modal><p>Read only</p></Modal>);
  assert.equal(active(), "modal");
  assert.equal(key({ key: "Tab" }).defaultPrevented, true);
  assert.equal(active(), "modal");
});

test("Escape closes only the topmost modal and respects selects and handled events", async () => {
  const closed: string[] = [];
  await mount(<Modal onClose={() => closed.push("outer")}><button>outer</button></Modal>);
  const { unmount } = await mount(<Modal onClose={() => closed.push("inner")}>
    <select data-id="select"><option>a</option></select><button>inner</button>
  </Modal>);
  const select = document.querySelector("select")!;
  assert.equal(key({ key: "Escape" }, select).defaultPrevented, false);
  const handled = new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  handled.preventDefault();
  document.body.dispatchEvent(handled as unknown as Event);
  assert.deepEqual(closed, []);
  assert.equal(key({ key: "Escape" }, document.body).defaultPrevented, true);
  assert.deepEqual(closed, ["inner"]);
  unmount();
  key({ key: "Escape" }, document.body);
  assert.deepEqual(closed, ["inner", "outer"]);
  key({ key: "Enter" }, document.body);
  assert.equal(closed.length, 2);
});

test("Escape without onClose leaves the modal open", async () => {
  await mount(<Modal><button>x</button></Modal>);
  assert.equal(key({ key: "Escape" }, document.body).defaultPrevented, false);
});

function pointer(target: Element, type: string, init: { pointerId?: number; button?: number; clientX?: number } = {}) {
  target.dispatchEvent(new window.PointerEvent(type, {
    bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, button: 0, clientX: 10, clientY: 10, ...init,
  }) as unknown as Event);
}
function click(target: Element) {
  target.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }) as unknown as Event);
}

test("only a complete stationary backdrop click dismisses", async () => {
  let closes = 0;
  const { host } = await mount(<Modal onClose={() => { closes += 1; }}><button>inside</button></Modal>);
  const backdrop = host.querySelector("[data-modal-root]")!;
  const inside = host.querySelector("button")!;
  const gesture = async (steps: () => void) => { await act(async () => steps()); };

  await gesture(() => { pointer(backdrop, "pointerdown"); pointer(backdrop, "pointerup", { clientX: 13 }); click(backdrop); });
  assert.equal(closes, 1);
  await gesture(() => { pointer(backdrop, "pointerdown"); pointer(backdrop, "pointermove", { clientX: 40 }); pointer(backdrop, "pointerup", { clientX: 40 }); click(backdrop); });
  await gesture(() => { pointer(backdrop, "pointerdown"); pointer(backdrop, "pointermove", { pointerId: 2 }); click(backdrop); });
  await gesture(() => { pointer(backdrop, "pointerdown"); pointer(backdrop, "pointermove", { clientX: 12 }); pointer(backdrop, "pointerup", { clientX: 30 }); click(backdrop); });
  await gesture(() => { pointer(backdrop, "pointerdown"); pointer(backdrop, "pointercancel"); click(backdrop); });
  await gesture(() => { pointer(backdrop, "pointerdown", { button: 2 }); pointer(backdrop, "pointerup"); click(backdrop); });
  await gesture(() => { pointer(inside, "pointerdown"); pointer(inside, "pointerup"); click(inside); });
  await gesture(() => { pointer(backdrop, "pointerdown"); pointer(backdrop, "pointerup"); click(inside); });
  await gesture(() => click(backdrop));
  assert.equal(closes, 1);
});
