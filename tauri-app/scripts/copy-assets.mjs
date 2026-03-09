#!/usr/bin/env node
/**
 * Assembles a complete assets/ directory for the Tauri app from multiple sources.
 * Run from the tauri-app/ directory (or it auto-detects via __dirname).
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const tauriApp = resolve(__dirname, "..");
const projectRoot = resolve(tauriApp, "..");
const dest = join(tauriApp, "src-tauri", "assets");

// Git-tracked sources (always available)
const webviewAssets = join(projectRoot, "webview-ui", "public", "assets");

// Build-output sources (may not exist if pipeline hasn't run)
const distAssets = join(projectRoot, "dist", "assets");
const distWebviewAssets = join(projectRoot, "dist", "webview", "assets");
const electronDistAssets = join(projectRoot, "electron", "dist", "assets");
const electronDistWebviewAssets = join(projectRoot, "electron", "dist", "webview", "assets");

// Ensure destination exists
mkdirSync(dest, { recursive: true });

let ok = true;

// 1. Characters — from webview-ui/public/assets/characters/
const charSrc = join(webviewAssets, "characters");
if (existsSync(charSrc)) {
  cpSync(charSrc, join(dest, "characters"), { recursive: true, force: true });
  console.log("[copy-assets] characters/ copied");
} else {
  console.warn("[copy-assets] WARNING: characters/ not found at", charSrc);
  ok = false;
}

// 2. walls.png — from webview-ui/public/assets/
const wallsSrc = join(webviewAssets, "walls.png");
if (existsSync(wallsSrc)) {
  cpSync(wallsSrc, join(dest, "walls.png"), { force: true });
  console.log("[copy-assets] walls.png copied");
} else {
  console.warn("[copy-assets] WARNING: walls.png not found");
  ok = false;
}

// 3. default-layout.json — from webview-ui/public/assets/
const layoutSrc = join(webviewAssets, "default-layout.json");
if (existsSync(layoutSrc)) {
  cpSync(layoutSrc, join(dest, "default-layout.json"), { force: true });
  console.log("[copy-assets] default-layout.json copied");
} else {
  console.warn("[copy-assets] WARNING: default-layout.json not found");
}

// 4. floors.png — search multiple locations
const floorsSearchPaths = [
  join(distAssets, "floors.png"),
  join(distWebviewAssets, "floors.png"),
  join(electronDistAssets, "floors.png"),
  join(electronDistWebviewAssets, "floors.png"),
];
const floorsSrc = floorsSearchPaths.find((p) => existsSync(p));
if (floorsSrc) {
  cpSync(floorsSrc, join(dest, "floors.png"), { force: true });
  console.log("[copy-assets] floors.png copied from", floorsSrc);
} else {
  console.warn(
    "[copy-assets] WARNING: floors.png not found in any location. Floor tiles won't render."
  );
  console.warn("  Searched:", floorsSearchPaths.join("\n           "));
}

// 5. furniture/ — from dist/assets/furniture/
const furnitureSearchPaths = [
  join(distAssets, "furniture"),
  join(distWebviewAssets, "furniture"),
  join(electronDistAssets, "furniture"),
  join(electronDistWebviewAssets, "furniture"),
];
const furnitureSrc = furnitureSearchPaths.find(
  (p) => existsSync(p) && existsSync(join(p, "furniture-catalog.json"))
);
if (furnitureSrc) {
  cpSync(furnitureSrc, join(dest, "furniture"), {
    recursive: true,
    force: true,
  });
  console.log("[copy-assets] furniture/ copied from", furnitureSrc);
} else {
  console.error(
    "[copy-assets] ERROR: furniture/ with furniture-catalog.json not found!"
  );
  console.error(
    "  Run the asset pipeline first: npx ts-node scripts/5-export-assets.ts"
  );
  ok = false;
}

// Summary
if (ok) {
  console.log("[copy-assets] Done. Assets assembled at", dest);
} else {
  console.warn("[copy-assets] Completed with warnings — some assets missing.");
}
