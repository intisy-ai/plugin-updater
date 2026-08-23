import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { UPDATER_DEFAULTS } from "../schema.js";

// The settings are stated twice on purpose: in code for what reads them, and in the manifest for a
// host that registers them without running this plugin. Nothing else keeps the two honest.
it("declares the same settings in the manifest as in code", () => {
  const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../../plugin.json", import.meta.url)), "utf8"));
  expect(manifest.config?.defaults).toEqual(UPDATER_DEFAULTS);
});
