import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deployedIdFor, readCloneManifest, syncManifestSidecar } from "../manifest.js";

describe("the clone's manifest", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "pu-manifest-")); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  function clone(name: string, manifest?: unknown): string {
    const dir = join(home, "repos", name);
    mkdirSync(dir, { recursive: true });
    if (manifest !== undefined) writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest));
    return dir;
  }

  it("names the deployed artifacts after the declared id, not the clone directory", () => {
    clone("checkout-name", { id: "declared-id", api: 1 });
    expect(deployedIdFor(join(home, "repos"), "checkout-name")).toBe("declared-id");
  });

  it("falls back to the clone directory when nothing is declared", () => {
    clone("plain");
    expect(deployedIdFor(join(home, "repos"), "plain")).toBe("plain");
  });

  it("treats a manifest with no id as no manifest, since it can name nothing", () => {
    clone("broken", { api: 1 });
    expect(readCloneManifest(join(home, "repos", "broken"))).toBeNull();
    expect(deployedIdFor(join(home, "repos"), "broken")).toBe("broken");
  });

  it("writes the manifest beside the bundle", () => {
    const dir = clone("demo", { id: "demo", api: 1, entry: "dist/plugin.js", capabilities: ["plugin-management"] });
    const pluginDir = join(home, "plugin");
    expect(syncManifestSidecar(dir, pluginDir, "demo")).toBe("written");
    expect(JSON.parse(readFileSync(join(pluginDir, "demo.json"), "utf8"))).toEqual({
      id: "demo", api: 1, entry: "dist/plugin.js", capabilities: ["plugin-management"],
    });
  });

  it("removes a sidecar the clone no longer declares", () => {
    const dir = clone("gone");
    const pluginDir = join(home, "plugin");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, "gone.json"), "{}");
    expect(syncManifestSidecar(dir, pluginDir, "gone")).toBe("removed");
    expect(existsSync(join(pluginDir, "gone.json"))).toBe(false);
  });

  it("reports nothing to do when neither the clone nor the home has one", () => {
    const dir = clone("neither");
    expect(syncManifestSidecar(dir, join(home, "plugin"), "neither")).toBe("none");
  });
});

// The deploy directory holds more than bundles: an ESM marker the directory itself needs, the
// shared store, and three artifacts per plugin. A sweep that reads a basename has to be told what
// is not a plugin, or it deletes the marker every plugin's import then warns about.
describe("pruning the deploy directory", () => {
  let home: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "pu-prune-"));
    for (const key of ["HUB_CONFIG_DIR", "PLUGIN_UPDATER_APP"]) saved[key] = process.env[key];
    process.env.HUB_CONFIG_DIR = home;
    process.env.PLUGIN_UPDATER_APP = "opencode";
  });
  afterEach(() => {
    for (const key of ["HUB_CONFIG_DIR", "PLUGIN_UPDATER_APP"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key] as string;
    }
    rmSync(home, { recursive: true, force: true });
  });

  it("removes every artifact of a plugin the home no longer lists, and nothing else", async () => {
    const { pruneOrphans } = await import("../index.js");
    const pluginDir = join(home, "plugin");
    mkdirSync(join(pluginDir, "node_modules"), { recursive: true });
    mkdirSync(join(home, "repos", "kept"), { recursive: true });
    writeFileSync(join(home, "repos", "kept", "plugin.json"), JSON.stringify({ id: "kept", api: 1 }));
    for (const name of ["kept.js", "kept.json", "kept.sha", "orphan.js", "orphan.json", "orphan.sha"]) {
      writeFileSync(join(pluginDir, name), "x");
    }
    writeFileSync(join(pluginDir, "package.json"), JSON.stringify({ type: "module" }));

    pruneOrphans(home, [{ name: "kept", url: "https://github.com/intisy-ai/kept" }]);

    expect(existsSync(join(pluginDir, "kept.js"))).toBe(true);
    expect(existsSync(join(pluginDir, "kept.json"))).toBe(true);
    expect(existsSync(join(pluginDir, "kept.sha"))).toBe(true);
    expect(existsSync(join(pluginDir, "orphan.js"))).toBe(false);
    expect(existsSync(join(pluginDir, "orphan.json"))).toBe(false);
    expect(existsSync(join(pluginDir, "orphan.sha"))).toBe(false);
    expect(existsSync(join(pluginDir, "package.json"))).toBe(true);
    expect(existsSync(join(pluginDir, "node_modules"))).toBe(true);
  });

  it("keeps the artifacts of a plugin whose manifest id differs from its clone directory", async () => {
    const { pruneOrphans } = await import("../index.js");
    const pluginDir = join(home, "plugin");
    mkdirSync(pluginDir, { recursive: true });
    mkdirSync(join(home, "repos", "checkout-name"), { recursive: true });
    writeFileSync(join(home, "repos", "checkout-name", "plugin.json"), JSON.stringify({ id: "declared-id", api: 1 }));
    writeFileSync(join(pluginDir, "declared-id.js"), "x");

    pruneOrphans(home, [{ name: "checkout-name", url: "https://github.com/intisy-ai/checkout-name" }]);

    expect(existsSync(join(pluginDir, "declared-id.js"))).toBe(true);
  });
});
