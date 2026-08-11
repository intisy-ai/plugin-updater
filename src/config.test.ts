import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { registerPlugin, setPluginEnabled, setPluginAutoUpdate, getPlugins } from "./config.js";
import { UPDATER_DEFAULTS } from "./schema.js";

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
  it("ships the channel off, naming the branch it would use", () => {
    expect(UPDATER_DEFAULTS.experimental).toBe(false);
    expect(UPDATER_DEFAULTS.experimental_branch).toBe("experimental");
  });
});
