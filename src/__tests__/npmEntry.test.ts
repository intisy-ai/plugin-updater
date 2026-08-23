import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { resolveNpmPluginEntry, resolveNpmPluginManifest, resolveNpmPluginVersion } from "../npm.js";

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "pu-npm-entry-"));
});

afterEach(() => {
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

function installed(name: string, manifest: Record<string, unknown>, files: Record<string, string> = {}): string {
  const dir = path.join(home, "node_modules", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(manifest), "utf8");
  for (const [file, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), body, "utf8");
  }
  return dir;
}

describe("resolving an npm plugin in a home", () => {
  it("reports the entry the package declares", () => {
    const dir = installed("widget", { version: "2.0.0", main: "dist/index.js" }, { "dist/index.js": "" });
    expect(resolveNpmPluginEntry("widget", home)).toBe(path.join(dir, "dist", "index.js"));
  });

  it("falls back to index.js when the package declares no main", () => {
    const dir = installed("widget", { version: "2.0.0" }, { "index.js": "" });
    expect(resolveNpmPluginEntry("widget", home)).toBe(path.join(dir, "index.js"));
  });

  it("reports nothing when the declared entry is not actually there", () => {
    installed("widget", { version: "2.0.0", main: "dist/index.js" });
    expect(resolveNpmPluginEntry("widget", home)).toBe("");
  });

  it("reports nothing for a package this home does not have", () => {
    expect(resolveNpmPluginManifest("absent-widget-xyz", home)).toBe("");
    expect(resolveNpmPluginEntry("absent-widget-xyz", home)).toBe("");
  });

  it("still reads the version from the same manifest", () => {
    installed("widget", { version: "2.0.0", main: "index.js" }, { "index.js": "" });
    expect(resolveNpmPluginVersion("widget", home)).toBe("2.0.0");
  });
});
