import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(
  new URL("../overlays/world-node-interaction-v1.js", import.meta.url),
  "utf8",
);
const head = readFileSync(
  new URL("../overlays/world-node-interaction-v1.head.html", import.meta.url),
  "utf8",
);

class FakeElement {
  constructor() {
    this.isConnected = true;
    this.selected = false;
    this.classList = { contains: (name) => name === "is-selected" && this.selected };
  }

  closest(selector) {
    return selector === 'svg g.graph-node[role="button"]' ? this : null;
  }
}

function loadBridge({ selected = false, detailOpen = false } = {}) {
  const listeners = new Map();
  const node = new FakeElement();
  node.selected = selected;
  let open = detailOpen;
  let clickCount = 0;
  let keydownCount = 0;
  let prevented = false;

  node["__reactProps$test"] = {
    onClick: () => {
      clickCount += 1;
      node.selected = true;
      open = true;
    },
    onKeyDown: () => {
      keydownCount += 1;
      node.selected = true;
      open = true;
    },
  };

  const document = {
    addEventListener: (type, handler, capture) => listeners.set(type, { handler, capture }),
    querySelector: () => (open ? {} : null),
  };
  const context = vm.createContext({
    document,
    Element: FakeElement,
    window: { setTimeout: (handler) => handler() },
  });
  vm.runInContext(source, context);

  return {
    listeners,
    node,
    click: () => listeners.get("click").handler({ target: node }),
    keydown: (key) =>
      listeners.get("keydown").handler({
        target: node,
        key,
        preventDefault: () => {
          prevented = true;
        },
      }),
    counts: () => ({ clickCount, keydownCount, prevented }),
  };
}

test("the overlay has a stable public script reference", () => {
  assert.equal(head.trim(), '<script defer src="/world/world-node-interaction-v1.js"></script>');
});

test("capture listeners recover a missing React click dispatch", () => {
  const bridge = loadBridge();
  assert.equal(bridge.listeners.get("click").capture, true);
  bridge.click();
  assert.deepEqual(bridge.counts(), { clickCount: 1, keydownCount: 0, prevented: false });
});

test("the bridge does not duplicate a successful React click", () => {
  const bridge = loadBridge({ selected: true, detailOpen: true });
  bridge.click();
  assert.deepEqual(bridge.counts(), { clickCount: 0, keydownCount: 0, prevented: false });
});

test("Enter and Space recover the keyboard handler", () => {
  const enter = loadBridge();
  enter.keydown("Enter");
  assert.deepEqual(enter.counts(), { clickCount: 0, keydownCount: 1, prevented: false });

  const space = loadBridge();
  space.keydown(" ");
  assert.deepEqual(space.counts(), { clickCount: 0, keydownCount: 1, prevented: true });
});
