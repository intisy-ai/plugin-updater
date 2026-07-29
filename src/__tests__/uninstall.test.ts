import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uninstallPlugin } from "../index.js";
import { getPluginsPath } from "../config.js";

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "updater-uninstall-"));
  mkdirSync(join(configDir, "config"), { recursive: true });
  mkdirSync(join(configDir, "repos", "plugin-a"), { recursive: true });
  mkdirSync(join(configDir, "repos", "plugin-b"), { recursive: true });
  mkdirSync(join(configDir, "plugin"), { recursive: true });
  writeFileSync(join(configDir, "plugin", "plugin-a.js"), "// bundle");
  writeFileSync(join(configDir, "plugin", "plugin-b.js"), "// bundle");
  writeFileSync(
    getPluginsPath(configDir),
    JSON.stringify([
      { name: "plugin-a", url: "https://github.com/intisy-ai/plugin-a", enabled: true },
      { name: "plugin-b", url: "https://github.com/intisy-ai/plugin-b", enabled: false },
    ]),
  );
});

afterEach(() => rmSync(configDir, { recursive: true, force: true }));

describe("uninstallPlugin", () => {
  it("removes the entry and prunes the clone and deployed bundle, leaving others intact", () => {
    uninstallPlugin(configDir, "plugin-a");
    const entries = JSON.parse(readFileSync(getPluginsPath(configDir), "utf8"));
    expect(entries.map((e: { name: string }) => e.name)).toEqual(["plugin-b"]);
    expect(existsSync(join(configDir, "repos", "plugin-a"))).toBe(false);
    expect(existsSync(join(configDir, "plugin", "plugin-a.js"))).toBe(false);
    expect(existsSync(join(configDir, "repos", "plugin-b"))).toBe(true);
    expect(existsSync(join(configDir, "plugin", "plugin-b.js"))).toBe(true);
    expect(entries[0].enabled).toBe(false);
  });

  it("throws on an unknown name without touching the file", () => {
    expect(() => uninstallPlugin(configDir, "nope")).toThrow("plugin not found: nope");
    const entries = JSON.parse(readFileSync(getPluginsPath(configDir), "utf8"));
    expect(entries).toHaveLength(2);
  });
});
