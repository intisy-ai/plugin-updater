import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { registerPlugin, setPluginEnabled, setPluginAutoUpdate, getPlugins } from "./config.js";
import { UPDATER_DEFAULTS, UPDATER_NAME, UPDATER_SETTINGS } from "./schema.js";
// @ts-ignore: generated bundle, no .d.ts
import { loadConfig } from "@intisy-ai/basekit";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pu-config-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("plugins.json writers", () => {
  it("registerPlugin adds a new entry with defaults", () => {
    registerPlugin(dir, "plugin-a", "https://github.com/intisy-ai/plugin-a");
    expect(getPlugins(dir)).toEqual([
      { name: "plugin-a", url: "https://github.com/intisy-ai/plugin-a", enabled: true, autoUpdate: true },
    ]);
  });

  it("registerPlugin refreshes the url without duplicating or clobbering other fields", () => {
    registerPlugin(dir, "plugin-a", "u1", false);
    registerPlugin(dir, "plugin-a", "u2");
    const entries = getPlugins(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ name: "plugin-a", url: "u2", enabled: true, autoUpdate: false });
  });

  it("setPluginEnabled and setPluginAutoUpdate flip fields and report the entry was found", () => {
    registerPlugin(dir, "plugin-a", "u1");
    expect(setPluginEnabled(dir, "plugin-a", false)).toBe(true);
    expect(setPluginAutoUpdate(dir, "plugin-a", false)).toBe(true);
    expect(getPlugins(dir)[0]).toMatchObject({ enabled: false, autoUpdate: false });
  });

  it("the setters return false for an unknown plugin or a missing file", () => {
    expect(setPluginEnabled(dir, "nope", true)).toBe(false);
    registerPlugin(dir, "plugin-a", "u1");
    expect(setPluginAutoUpdate(dir, "nope", true)).toBe(false);
  });
});

describe("channel defaults", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pu-channel-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("with no config file on disk, loadConfig returns empty; merge with defaults yields the channel settings", () => {
    const diskConfig = loadConfig(UPDATER_NAME, tempDir);
    expect(diskConfig).toEqual({});

    const merged = { ...UPDATER_DEFAULTS, ...diskConfig };
    expect(merged.experimental).toBe(false);
    expect(merged.experimental_branch).toBe("experimental");
  });

  it("with a config file on disk, the merge resolves file values over defaults", () => {
    fs.mkdirSync(path.join(tempDir, "config"), { recursive: true });
    const configFile = path.join(tempDir, "config", `${UPDATER_NAME}.json`);
    fs.writeFileSync(configFile, JSON.stringify({
      experimental: true,
      experimental_branch: "next",
      other_field: "value"
    }), "utf8");

    const diskConfig = loadConfig(UPDATER_NAME, tempDir);
    expect(diskConfig.experimental).toBe(true);
    expect(diskConfig.experimental_branch).toBe("next");
    expect(diskConfig.other_field).toBe("value");

    const merged = { ...UPDATER_DEFAULTS, ...diskConfig };
    expect(merged.experimental).toBe(true);
    expect(merged.experimental_branch).toBe("next");
    expect(merged.logging).toBe(true);
  });

  it("the registered field list contains both channel settings and every non-dotted key corresponds to a default", () => {
    const fieldKeys = (UPDATER_SETTINGS.fields || []).map((f: { key: string }) => f.key);

    expect(fieldKeys).toContain("experimental");
    expect(fieldKeys).toContain("experimental_branch");

    const defaultKeys = Object.keys(UPDATER_DEFAULTS).filter(k => !k.includes("."));
    for (const fieldKey of fieldKeys) {
      if (!fieldKey.includes(".")) {
        expect(defaultKeys).toContain(fieldKey);
      }
    }
  });
});
