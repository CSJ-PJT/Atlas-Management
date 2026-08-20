import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bindNodeInteraction } from "../overlays/world-node-native-listener-v1.js";
import { applyWorldNativeInteractionOverlay } from "../scripts/build-world-native-interaction-overlay.mjs";

const graphSource = readFileSync(
  new URL("../overlays/world-graph-view-native-v1.js", import.meta.url),
  "utf8",
);

class FakeElement {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) ?? [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  removeEventListener(type, handler) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((candidate) => candidate !== handler),
    );
  }

  dispatch(type, event = {}) {
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }
}

test("native node listeners activate once and clean up", () => {
  const element = new FakeElement();
  let activations = 0;
  let prevented = false;
  const cleanup = bindNodeInteraction(element, () => {
    activations += 1;
  });

  element.dispatch("click");
  element.dispatch("keydown", { key: "Enter", preventDefault: () => (prevented = true) });
  element.dispatch("keydown", { key: " ", preventDefault: () => (prevented = true) });
  element.dispatch("keydown", { key: "Escape", preventDefault: () => (prevented = true) });
  assert.equal(activations, 3);
  assert.equal(prevented, true);

  cleanup();
  element.dispatch("click");
  assert.equal(activations, 3);
  assert.equal(element.listeners.get("click").length, 0);
  assert.equal(element.listeners.get("keydown").length, 0);
});

test("GraphView binds and cleans native listeners without synthetic click handlers", () => {
  assert.match(graphSource, /React\.useEffect/);
  assert.match(graphSource, /return bindNodeInteraction\(element, \(\) => onSelect\(node\)\)/);
  assert.doesNotMatch(graphSource, /onClick\s*:/);
  assert.doesNotMatch(graphSource, /onKeyDown\s*:/);
});

test("the artifact overlay creates versioned entry and GraphView assets", () => {
  const root = mkdtempSync(join(tmpdir(), "world-native-overlay-"));
  const assets = join(root, "assets");
  mkdirSync(assets);
  writeFileSync(
    join(root, "index.html"),
    '<script type="module" src="/world/assets/index-OLD.js"></script>',
  );
  writeFileSync(join(assets, "index-OLD.js"), 'import("./GraphView-OLD.js")');
  writeFileSync(join(assets, "GraphView-OLD.js"), "export const legacy = true;");

  try {
    assert.throws(
      () => applyWorldNativeInteractionOverlay(root),
      /operating twin SHA256 mismatch/,
    );
    const hash = (value) => createHash("sha256").update(value).digest("hex");
    const result = applyWorldNativeInteractionOverlay(root, {
      entrySha256: hash('import("./GraphView-OLD.js")'),
      graphSha256: hash("export const legacy = true;"),
    });
    assert.equal(result.currentEntry, "index-OLD.js");
    assert.equal(result.currentGraph, "GraphView-OLD.js");
    assert.match(readFileSync(join(root, "index.html"), "utf8"), /index-world-node-native-v1\.js/);
    assert.match(
      readFileSync(join(assets, "index-world-node-native-v1.js"), "utf8"),
      /world-graph-view-native-v1\.js/,
    );
    assert.match(
      readFileSync(join(assets, "world-graph-view-native-v1.js"), "utf8"),
      /bindNodeInteraction/,
    );
    assert.match(
      readFileSync(join(assets, "world-node-native-listener-v1.js"), "utf8"),
      /removeEventListener/,
    );
    assert.equal(existsSync(join(assets, "index-OLD.js")), false);
    assert.equal(existsSync(join(assets, "GraphView-OLD.js")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
