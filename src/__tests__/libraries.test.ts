import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { homeLibraries, pluginDependencies, sharedLibraries } from "../libraries.js";

let homeDir: string | undefined;
afterEach(() => {
  if (homeDir) rmSync(homeDir, { recursive: true, force: true });
  homeDir = undefined;
});

function writePackage(dir: string, pkg: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
}

function makeHome(): string {
  homeDir = mkdtempSync(join(tmpdir(), "plugin-updater-libs-"));
  return homeDir;
}

// A clone that declares its libraries as submodules, which is where the "used by" answer
// comes from. Its own npm dependencies are declared and installed separately.
function makeClone(home: string, plugin: string, options: {
  submodules?: Record<string, string>;
  dependencies?: Record<string, string>;
  installed?: Record<string, string>;
} = {}): void {
  const cloneDir = join(home, "repos", plugin);
  mkdirSync(cloneDir, { recursive: true });
  const submodules = options.submodules ?? {};
  if (Object.keys(submodules).length > 0) {
    writeFileSync(
      join(cloneDir, ".gitmodules"),
      Object.keys(submodules).map((p) => `[submodule "${p}"]\n\tpath = ${p}\n\turl = https://example.invalid/${p}\n`).join(""),
    );
    for (const [relative, name] of Object.entries(submodules)) writePackage(join(cloneDir, relative), { name });
  }
  if (options.dependencies) writePackage(cloneDir, { name: plugin, dependencies: options.dependencies });
  for (const [name, version] of Object.entries(options.installed ?? {})) {
    writePackage(join(cloneDir, "node_modules", ...name.split("/")), { name, version });
  }
}

function shareLibrary(home: string, specifier: string, version: string): void {
  writePackage(join(home, "node_modules", ...specifier.split("/")), { name: specifier, version });
}

describe("sharedLibraries", () => {
  it("reads the home store, descending into scopes", () => {
    const home = makeHome();
    shareLibrary(home, "@intisy-ai/core", "2.1.0");
    shareLibrary(home, "@intisy-ai/core-auth", "1.4.0");

    expect(sharedLibraries(home)).toEqual([
      { specifier: "@intisy-ai/core", version: "2.1.0", usedBy: [] },
      { specifier: "@intisy-ai/core-auth", version: "1.4.0", usedBy: [] },
    ]);
  });

  // A shared library is only worth keeping while something declares it, so the answer to
  // "who needs this" comes from the clones rather than from a list kept alongside.
  it("names the plugins that declare each library", () => {
    const home = makeHome();
    shareLibrary(home, "@intisy-ai/core", "2.1.0");
    makeClone(home, "stub-auth", { submodules: { core: "core", "core-auth": "core-auth" } });
    makeClone(home, "wakatime-sync", { submodules: { core: "core" } });

    const core = sharedLibraries(home).find((l) => l.specifier === "@intisy-ai/core");
    expect(core?.usedBy).toEqual(["stub-auth", "wakatime-sync"]);
  });

  it("is empty when the home has no store yet", () => {
    expect(sharedLibraries(makeHome())).toEqual([]);
  });
});

describe("pluginDependencies", () => {
  it("reports the version installed next to the plugin, not the range it asks for", () => {
    const home = makeHome();
    makeClone(home, "wakatime-sync", { dependencies: { undici: "^6.0.0" }, installed: { undici: "6.19.2" } });

    expect(pluginDependencies(home, "wakatime-sync")).toEqual([{ specifier: "undici", version: "6.19.2", usedBy: [] }]);
  });

  // A dependency that never got installed is the one worth seeing, so it is listed rather
  // than quietly dropped for having no package.json to read.
  it("lists a declared dependency that is not installed", () => {
    const home = makeHome();
    makeClone(home, "wakatime-sync", { dependencies: { undici: "^6.0.0" } });

    expect(pluginDependencies(home, "wakatime-sync")).toEqual([{ specifier: "undici", version: "", usedBy: [] }]);
  });

  it("is empty for a plugin that declares none", () => {
    const home = makeHome();
    makeClone(home, "stub-auth", { submodules: { core: "core" } });
    expect(pluginDependencies(home, "stub-auth")).toEqual([]);
  });
});

describe("homeLibraries", () => {
  it("puts the shared store alongside each plugin that has dependencies of its own", () => {
    const home = makeHome();
    shareLibrary(home, "@intisy-ai/core", "2.1.0");
    makeClone(home, "wakatime-sync", { submodules: { core: "core" }, dependencies: { undici: "^6.0.0" }, installed: { undici: "6.19.2" } });
    makeClone(home, "stub-auth", { submodules: { core: "core" } });

    const result = homeLibraries(home);
    expect(result.shared).toEqual([{ specifier: "@intisy-ai/core", version: "2.1.0", usedBy: ["stub-auth", "wakatime-sync"] }]);
    expect(result.plugins).toEqual([{ plugin: "wakatime-sync", dependencies: [{ specifier: "undici", version: "6.19.2", usedBy: [] }] }]);
  });
});
