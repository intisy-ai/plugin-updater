// The manifest is validated by the same assertion the host runs when it reads the sidecar, so a
// manifest that would quarantine this plugin in a real home fails here instead.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
// @ts-ignore - built output of the nested checkout, resolved by relative path like the contract test
import { assertManifest } from "../../core/api/dist/index.js";

// fileURLToPath, not new URL().pathname: on Windows the latter yields a leading-slash path that
// doubles the drive letter when joined.
const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const manifest = JSON.parse(readFileSync(join(repoRoot, "plugin.json"), "utf8"));

describe("plugin.json", () => {
  it("validates against the published manifest schema", () => {
    expect(() => assertManifest(manifest)).not.toThrow();
  });

  it("declares the capability that makes this the plugin manager", () => {
    expect(manifest.capabilities).toEqual(["plugin-management"]);
  });

  it("points its entry at the bundle deploy actually copies", () => {
    expect(manifest.entry).toBe("dist/plugin.js");
  });

  it("is named after the repository, which is what the deployed sidecar is named after", () => {
    expect(manifest.id).toBe("plugin-updater");
  });
});
