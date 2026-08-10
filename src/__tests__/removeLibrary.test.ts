import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
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

function installLibrary(specifier: string, version = "1.0.0"): string {
  const dir = join(home, "node_modules", ...specifier.split("/"));
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: specifier, version, main: "dist/index.js" }));
  writeFileSync(join(dir, "dist", "index.js"), "");
  return dir;
}

// A declarer is a cloned plugin whose .gitmodules names the library, which is how
// declaredLibraries decides who uses what.
function installDeclarer(plugin: string, submodule: string, packageName: string): void {
  const dir = join(home, "repos", plugin);
  mkdirSync(join(dir, submodule), { recursive: true });
  writeFileSync(join(dir, ".gitmodules"), `[submodule "${submodule}"]\n\tpath = ${submodule}\n\turl = https://example/${submodule}\n`);
  writeFileSync(join(dir, submodule, "package.json"), JSON.stringify({ name: packageName }));
}

describe("removeLibrary", () => {
  it("removes a library nothing declares", () => {
    const dir = installLibrary("@intisy-ai/left-behind");
    const result = removeLibrary(home, "@intisy-ai/left-behind");

    expect(result).toEqual({ removed: true, usedBy: [] });
    expect(existsSync(dir)).toBe(false);
  });

  // Plugins resolve their imports out of this store, so pulling a library they declare is the
  // "cannot find package" failure by hand.
  it("refuses while a plugin still declares it, and names the plugins", () => {
    const dir = installLibrary("@intisy-ai/core-auth");
    installDeclarer("antigravity-auth", "core-auth", "@intisy-ai/core-auth");

    const result = removeLibrary(home, "@intisy-ai/core-auth");

    expect(result.removed).toBe(false);
    expect(result.usedBy).toEqual(["antigravity-auth"]);
    expect(existsSync(dir)).toBe(true);
  });

  it("reports nothing removed for a library that is not there", () => {
    expect(removeLibrary(home, "@intisy-ai/never-installed")).toEqual({ removed: false, usedBy: [] });
  });
});

describe("orphanedLibraries", () => {
  it("names the libraries no installed plugin declares", () => {
    installLibrary("@intisy-ai/left-behind");
    installLibrary("@intisy-ai/core-auth");
    installDeclarer("antigravity-auth", "core-auth", "@intisy-ai/core-auth");

    expect(orphanedLibraries(home)).toEqual(["@intisy-ai/left-behind"]);
  });

  it("names nothing when every library has a declarer", () => {
    installLibrary("@intisy-ai/core-auth");
    installDeclarer("antigravity-auth", "core-auth", "@intisy-ai/core-auth");

    expect(orphanedLibraries(home)).toEqual([]);
  });
});
