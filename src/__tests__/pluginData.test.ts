import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pluginData, removePluginData } from "../plugin-data.js";

let homeDir: string | undefined;
afterEach(() => {
  if (homeDir) rmSync(homeDir, { recursive: true, force: true });
  homeDir = undefined;
});

function write(home: string, relative: string, contents = "x"): void {
  const target = join(home, relative);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, contents);
}

// A home carrying one plugin's state plus a neighbour's and the shared stores, which is
// what a name-scoped sweep has to tell apart.
function makeHome(): string {
  homeDir = mkdtempSync(join(tmpdir(), "plugin-updater-data-"));
  write(homeDir, "config/sync-bridge.json", "{}");
  write(homeDir, "config/sync-bridge.lastsynced", "123");
  write(homeDir, "config/accounts.json", "{}");
  write(homeDir, "config/settings.json", "{}");
  write(homeDir, "config/wakatime-sync.json", "{}");
  write(homeDir, "logs/2026-08-11/sync-bridge-09-00-00.log", "log");
  write(homeDir, "logs/2026-08-11/wakatime-sync-09-00-00.log", "log");
  write(homeDir, "cache/sync-bridge-state.json", "{}");
  return homeDir;
}

describe("pluginData", () => {
  it("finds the config and logs core named after the plugin, with no declaration", () => {
    const home = makeHome();
    expect(pluginData(home, "sync-bridge").map((entry) => entry.path)).toEqual([
      "config/sync-bridge.json",
      "config/sync-bridge.lastsynced",
      "logs/2026-08-11/sync-bridge-09-00-00.log",
    ]);
  });

  // Nothing in the cache carries an owner's name, so sweeping it by prefix would be a rule
  // matching nothing real; a plugin with cache of its own says so.
  it("leaves the cache alone unless the plugin declares it", () => {
    const home = makeHome();
    expect(pluginData(home, "sync-bridge").some((entry) => entry.path.startsWith("cache/"))).toBe(false);
    expect(pluginData(home, "sync-bridge", ["cache/sync-bridge-state.json"]).some((entry) => entry.declared)).toBe(true);
  });

  it("leaves the shared stores and another plugin's files alone", () => {
    const paths = pluginData(makeHome(), "sync-bridge").map((entry) => entry.path);
    expect(paths.some((path) => path.includes("accounts.json"))).toBe(false);
    expect(paths.some((path) => path.includes("settings.json"))).toBe(false);
    expect(paths.some((path) => path.includes("wakatime-sync"))).toBe(false);
  });

  // "wakatime-sync" starts with "wakatime", so a plain prefix test would claim it.
  it("does not claim a plugin whose name merely starts the same way", () => {
    const home = makeHome();
    expect(pluginData(home, "wakatime").map((entry) => entry.path)).toEqual([]);
  });

  it("reports a size for each entry so a confirmation can say what goes", () => {
    const home = makeHome();
    write(home, "config/sizeable.json", "0123456789");
    expect(pluginData(home, "sizeable")[0]).toMatchObject({ path: "config/sizeable.json", bytes: 10 });
  });

  it("adds a declared path and marks it as declared", () => {
    const home = makeHome();
    write(home, "state/sync-bridge-mirror/db.sqlite", "data");

    const entries = pluginData(home, "sync-bridge", ["state/sync-bridge-mirror"]);
    expect(entries.find((entry) => entry.path === "state/sync-bridge-mirror")).toMatchObject({ declared: true });
  });

  it("ignores a declared path that does not exist or escapes the home", () => {
    const home = makeHome();
    const entries = pluginData(home, "sync-bridge", ["state/never-created", "../outside"]);
    expect(entries.every((entry) => !entry.declared)).toBe(true);
  });

  it("never repeats a declared path the convention already found", () => {
    const home = makeHome();
    const entries = pluginData(home, "sync-bridge", ["config/sync-bridge.json"]);
    expect(entries.filter((entry) => entry.path === "config/sync-bridge.json")).toHaveLength(1);
  });
});

describe("removePluginData", () => {
  it("deletes exactly what it reported and leaves everything else standing", () => {
    const home = makeHome();

    const removed = removePluginData(home, "sync-bridge");

    expect(removed).toContain("config/sync-bridge.json");
    expect(existsSync(join(home, "config", "sync-bridge.json"))).toBe(false);
    expect(existsSync(join(home, "config", "sync-bridge.lastsynced"))).toBe(false);
    expect(existsSync(join(home, "logs", "2026-08-11", "sync-bridge-09-00-00.log"))).toBe(false);
    expect(existsSync(join(home, "config", "accounts.json"))).toBe(true);
    expect(existsSync(join(home, "config", "wakatime-sync.json"))).toBe(true);
    expect(existsSync(join(home, "logs", "2026-08-11", "wakatime-sync-09-00-00.log"))).toBe(true);
  });

  it("removes a declared directory whole", () => {
    const home = makeHome();
    write(home, "state/mirror/db.sqlite", "data");

    removePluginData(home, "sync-bridge", ["state/mirror"]);

    expect(existsSync(join(home, "state", "mirror"))).toBe(false);
  });

  it("removes nothing for a plugin that left nothing behind", () => {
    expect(removePluginData(makeHome(), "never-installed")).toEqual([]);
  });
});
