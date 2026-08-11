import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setPluginChannel } from "../config.js";
import type { Plugin } from "../types.js";

let home: string | undefined;
afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  home = undefined;
});

function makeHome(entries: Plugin[]): string {
  home = mkdtempSync(join(tmpdir(), "pu-channel-"));
  mkdirSync(join(home, "config"), { recursive: true });
  writeFileSync(join(home, "config", "plugins.json"), JSON.stringify(entries, null, 2), "utf8");
  return home;
}

function read(dir: string): Plugin[] {
  return JSON.parse(readFileSync(join(dir, "config", "plugins.json"), "utf8")) as Plugin[];
}

describe("setPluginChannel", () => {
  it("writes the channel onto the named entry only", () => {
    const dir = makeHome([{ name: "a", url: "u" }, { name: "b", url: "u" }]);
    expect(setPluginChannel(dir, "a", "experimental")).toBe(true);
    expect(read(dir)[0].channel).toBe("experimental");
    expect(read(dir)[1].channel).toBeUndefined();
  });

  // inherit is the absence of a choice, so it is removed rather than stored: a plugin that
  // stores "inherit" and one that never chose must behave identically.
  it("removes the field when set back to inherit", () => {
    const dir = makeHome([{ name: "a", url: "u", channel: "experimental" }]);
    expect(setPluginChannel(dir, "a", "inherit")).toBe(true);
    expect(read(dir)[0].channel).toBeUndefined();
  });

  it("reports a missing entry rather than creating one", () => {
    const dir = makeHome([{ name: "a", url: "u" }]);
    expect(setPluginChannel(dir, "nope", "experimental")).toBe(false);
    expect(read(dir)).toHaveLength(1);
  });
});
