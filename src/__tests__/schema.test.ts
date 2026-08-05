import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { updaterSchema, UPDATER_NAME } from "../schema.js";
// @ts-ignore — generated bundle, no .d.ts
import { loadConfig } from "../../lib/core.js";

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "updater-schema-"));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function writeConfig(dir: string, values: Record<string, unknown>, flat = false): void {
  const file = flat ? path.join(dir, "plugin-updater.json") : path.join(dir, "config", "plugin-updater.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(values), "utf8");
}

describe("updaterSchema", () => {
  it("reports the declared defaults and fields for a home with no config file", () => {
    const schema = updaterSchema(home);
    expect(schema.plugin).toBe(UPDATER_NAME);
    expect(schema.defaults.auto_update_mode).toBe("update");
    expect(schema.defaults.auto_update_triggers).toEqual({ loader: true, app: true, cairn: true });
    expect(schema.fields?.some((f) => f.key === "auto_update_mode")).toBe(true);
    expect(schema.current).toEqual({});
  });

  it("reports the values that home actually has on disk", () => {
    writeConfig(home, { auto_update_mode: "check" });
    expect(updaterSchema(home).current.auto_update_mode).toBe("check");
  });

  it("falls back to a config file at the home root", () => {
    writeConfig(home, { auto_update_mode: "off" }, true);
    expect(updaterSchema(home).current.auto_update_mode).toBe("off");
  });

  it("prefers the config subdir over the home root, like every other config reader", () => {
    writeConfig(home, { auto_update_mode: "off" }, true);
    writeConfig(home, { auto_update_mode: "check" });
    expect(updaterSchema(home).current.auto_update_mode).toBe("check");
  });

  it("carries the declared menu, so an engine can contribute one", () => {
    expect(updaterSchema(home).menu?.label).toBeTruthy();
  });

  // A dashboard reads the schema, writes a value through its OWN core instance, then reads
  // again. core's loadConfig caches per home for the life of the process (the absence of a
  // file included), so reading through it would report the pre-write state forever.
  it("reports a value written after this process already read that home", () => {
    expect(loadConfig(UPDATER_NAME, home)).toEqual({});
    writeConfig(home, { auto_update_mode: "check" });
    expect(updaterSchema(home).current.auto_update_mode).toBe("check");
  });

  it("treats an unreadable config as no values rather than throwing", () => {
    fs.mkdirSync(path.join(home, "config"), { recursive: true });
    fs.writeFileSync(path.join(home, "config", "plugin-updater.json"), "{ not json", "utf8");
    expect(updaterSchema(home).current).toEqual({});
  });
});
