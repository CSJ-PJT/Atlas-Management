import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const outputEntry = "index-world-node-native-v1.js";
const outputGraph = "world-graph-view-native-v1.js";
const outputListener = "world-node-native-listener-v1.js";
export const OPERATING_TWIN = Object.freeze({
  entrySha256: "78be8e3c9f55dd31def1653f1e7c1b7f6cbb3519ef34ab653a8889e4f8400a81",
  graphSha256: "b960083140ac755ab4b02de74b9acca8c5e56074113cf7b9ab3cf67f91a70a49",
});

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

export function applyWorldNativeInteractionOverlay(worldDir, expectedTwin = OPERATING_TWIN) {
  const indexPath = join(worldDir, "index.html");
  const assetsDir = join(worldDir, "assets");
  const indexHtml = readFileSync(indexPath, "utf8");
  const entryMatch = indexHtml.match(/\/world\/assets\/(index-[A-Za-z0-9_-]+\.js)/);
  if (!entryMatch) throw new Error("World entry asset was not found in index.html");

  const currentEntry = entryMatch[1];
  const currentEntryPath = join(assetsDir, currentEntry);
  const entryBytes = readFileSync(currentEntryPath);
  const entrySource = entryBytes.toString("utf8");
  const graphMatch = entrySource.match(/\.\/(GraphView-[A-Za-z0-9_-]+\.js)/);
  if (!graphMatch) throw new Error("World GraphView lazy chunk was not found in the entry asset");
  const currentGraph = graphMatch[1];
  const graphPath = join(assetsDir, currentGraph);
  const entrySha256 = sha256(entryBytes);
  const graphSha256 = sha256(readFileSync(graphPath));
  if (entrySha256 !== expectedTwin.entrySha256 || graphSha256 !== expectedTwin.graphSha256) {
    throw new Error("World operating twin SHA256 mismatch; refusing to build the overlay");
  }

  mkdirSync(assetsDir, { recursive: true });
  writeFileSync(
    join(assetsDir, outputEntry),
    entrySource.replace(graphMatch[0], `./${outputGraph}`),
  );
  copyFileSync(join(repoRoot, "overlays", "world-graph-view-native-v1.js"), join(assetsDir, outputGraph));
  copyFileSync(
    join(repoRoot, "overlays", "world-node-native-listener-v1.js"),
    join(assetsDir, outputListener),
  );
  writeFileSync(
    indexPath,
    indexHtml.replace(`/world/assets/${currentEntry}`, `/world/assets/${outputEntry}`),
  );
  rmSync(currentEntryPath);
  rmSync(graphPath);

  return {
    currentEntry,
    currentGraph,
    entrySha256,
    graphSha256,
    outputEntry,
    outputGraph,
    outputListener,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const worldDir = process.argv[2];
  if (!worldDir) throw new Error("Usage: node build-world-native-interaction-overlay.mjs <world-dir>");
  process.stdout.write(`${JSON.stringify(applyWorldNativeInteractionOverlay(resolve(worldDir)))}\n`);
}
