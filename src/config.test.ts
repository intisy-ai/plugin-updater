import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { registerPlugin, setPluginEnabled, setPluginAutoUpdate, getPlugins } from "./config.js";
import { UPDATER_DEFAULTS, UPDATER_NAME, readUpdaterConfig } from "./schema.js";
// @ts-ignore: generated bundle, no .d.ts
import { getCapabilities, getConfigDefaults } from "@intisy-ai/core";

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

  it("with no config file on disk, readUpdaterConfig returns empty; but the registered defaults via getConfigDefaults still include the channel settings", () => {
    const diskConfig = readUpdaterConfig(tempDir);
    expect(diskConfig).toEqual({});

    const registered = getConfigDefaults(UPDATER_NAME);
    expect(registered.experimental).toBe(false);
    expect(registered.experimental_branch).toBe("experimental");
  });

  it("the registered field list contains both channel settings and every non-dotted key corresponds to a default", () => {
    const caps = getCapabilities(UPDATER_NAME);
    const fieldKeys = (caps.fields || []).map((f: { key: string }) => f.key);

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
