// The manifest type is what every later file in this repo types its manifest handling against, so
// a broken path mapping has to fail here rather than as a wall of errors in an unrelated task.
import { describe, expect, it } from "vitest";
import type { PluginManifest } from "@intisy-ai/api";

describe("the api types resolve", () => {
  it("types a manifest", () => {
    const manifest: PluginManifest = { id: "plugin-updater", api: 1 };
    expect(manifest.id).toBe("plugin-updater");
  });
});
