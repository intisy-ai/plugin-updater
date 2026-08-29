import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeLibrary, orphanedLibraries } from "../libraries.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pu-remove-lib-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function installLibrary(specifier: string, version = "1.0.0", dependencies?: Record<string, string>): string {
  const dir = join(home, "node_modules", ...specifier.split("/"));
  mkdirSync(join(dir, "dist"), { recursive: true });
  const pkg: Record<string, unknown> = { name: specifier, version, main: "dist/index.js" };
  if (dependencies) pkg.dependencies = dependencies;
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
  writeFileSync(join(dir, "dist", "index.js"), "");
  return dir;
}

// A declarer is a cloned plugin whose package.json depends on the library, which is how
// declaredLibraries decides who uses what.
function installDeclarer(plugin: string, ...packageNames: string[]): void {
  const dir = join(home, "repos", plugin);
  mkdirSync(dir, { recursive: true });
  const dependencies = Object.fromEntries(packageNames.map((name) => [name, "^1.0.0"]));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: plugin, dependencies }));
}

// Filling the store is npm's, so a test stands in for it rather than reaching the registry.
// This mirrors the part that matters here: what the manifest stops asking for goes away.
function fakePrune(configDir: string): void {
  const manifest = JSON.parse(readFileSync(join(configDir, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const scope = join(configDir, "node_modules", "@intisy-ai");
  if (!existsSync(scope)) return;
  for (const name of readdirSync(scope)) {
    if (!(`@intisy-ai/${name}` in (manifest.dependencies ?? {}))) rmSync(join(scope, name), { recursive: true, force: true });
  }
}

// The home manifest is what a real deploy would have written, and it is what dropLibrary edits.
function writeHomeManifest(dependencies: Record<string, string>): void {
  writeFileSync(join(home, "package.json"), JSON.stringify({ name: "home", private: true, dependencies }));
}

describe("removeLibrary", () => {
  it("removes a library nothing declares", () => {
    const dir = installLibrary("@intisy-ai/left-behind");
    writeHomeManifest({ "@intisy-ai/left-behind": "^1.0.0" });

    const result = removeLibrary(home, "@intisy-ai/left-behind", fakePrune);

    expect(result).toEqual({ removed: true, usedBy: [] });
    expect(existsSync(dir)).toBe(false);
  });

  it("leaves the home manifest asking for nothing it removed", () => {
    installLibrary("@intisy-ai/left-behind");
    installLibrary("@intisy-ai/kept");
    writeHomeManifest({ "@intisy-ai/left-behind": "^1.0.0", "@intisy-ai/kept": "^1.0.0" });

    removeLibrary(home, "@intisy-ai/left-behind", fakePrune);

    const manifest = JSON.parse(readFileSync(join(home, "package.json"), "utf8")) as { dependencies: Record<string, string> };
    expect(Object.keys(manifest.dependencies)).toEqual(["@intisy-ai/kept"]);
  });

  // Plugins resolve their imports out of this store, so pulling a library they declare is the
  // "cannot find package" failure by hand.
  it("refuses while a plugin still declares it, and names the plugins", () => {
    const dir = installLibrary("@intisy-ai/anthropic-translator");
    writeHomeManifest({ "@intisy-ai/anthropic-translator": "^1.0.0" });
    installDeclarer("antigravity-auth", "@intisy-ai/anthropic-translator");

    const result = removeLibrary(home, "@intisy-ai/anthropic-translator", fakePrune);

    expect(result.removed).toBe(false);
    expect(result.usedBy).toEqual(["antigravity-auth"]);
    expect(existsSync(dir)).toBe(true);
  });

  // The plugin names `@intisy-ai/anthropic-translator`, which requires basekit, so nothing declares basekit directly.
  // Crediting only the direct ask would offer a library the plugin still imports for removal.
  it("refuses for a library a plugin reaches only through another one", () => {
    installLibrary("@intisy-ai/anthropic-translator", "1.0.0", { "@intisy-ai/basekit": "^1.0.0" });
    installLibrary("@intisy-ai/basekit");
    writeHomeManifest({ "@intisy-ai/anthropic-translator": "^1.0.0", "@intisy-ai/basekit": "^1.0.0" });
    installDeclarer("antigravity-auth", "@intisy-ai/anthropic-translator");

    const result = removeLibrary(home, "@intisy-ai/basekit", fakePrune);

    expect(result.removed).toBe(false);
    expect(result.usedBy).toEqual(["antigravity-auth"]);
  });

  it("reports nothing removed for a library that is not there", () => {
    expect(removeLibrary(home, "@intisy-ai/never-installed", fakePrune)).toEqual({ removed: false, usedBy: [] });
  });
});

describe("orphanedLibraries", () => {
  it("names the libraries no installed plugin declares", () => {
    installLibrary("@intisy-ai/left-behind");
    installLibrary("@intisy-ai/anthropic-translator");
    installDeclarer("antigravity-auth", "@intisy-ai/anthropic-translator");

    expect(orphanedLibraries(home)).toEqual(["@intisy-ai/left-behind"]);
  });

  it("names nothing when every library has a declarer", () => {
    installLibrary("@intisy-ai/anthropic-translator");
    installDeclarer("antigravity-auth", "@intisy-ai/anthropic-translator");

    expect(orphanedLibraries(home)).toEqual([]);
  });

  it("does not call a transitively-required library orphaned", () => {
    installLibrary("@intisy-ai/anthropic-translator", "1.0.0", { "@intisy-ai/basekit": "^1.0.0" });
    installLibrary("@intisy-ai/basekit");
    installDeclarer("antigravity-auth", "@intisy-ai/anthropic-translator");

    expect(orphanedLibraries(home)).toEqual([]);
  });
});
