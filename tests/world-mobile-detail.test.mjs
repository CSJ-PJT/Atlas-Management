import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../overlays/world-mobile-detail-v1.css", import.meta.url), "utf8");
const head = readFileSync(new URL("../overlays/world-mobile-detail-v1.head.html", import.meta.url), "utf8");

test("mobile detail keeps the graph card inside the viewport grid", () => {
  assert.match(css, /@media \(max-width: 700px\)/);
  assert.match(css, /\.workspace\.has-details\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
  assert.match(css, /\.workspace\.has-details\s*>\s*\*/);
  assert.match(css, /min-width:\s*0/);
});

test("the overlay has a stable public head reference", () => {
  assert.equal(head.trim(), '<link rel="stylesheet" href="/world/world-mobile-detail-v1.css">');
});
