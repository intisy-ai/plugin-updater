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

// A clone declares the libraries it needs the way any npm package does, which is where the
// "used by" answer comes from. `installed` is what npm left next to the clone itself.
function makeClone(home: string, plugin: string, options: {
  libraries?: string[];
  dependencies?: Record<string, string>;
  installed?: Record<string, string>;
} = {}): void {
  const cloneDir = join(home, "repos", plugin);
  const scoped = Object.fromEntries((options.libraries ?? []).map((specifier) => [specifier, "^1.0.0"]));
  writePackage(cloneDir, { name: plugin, dependencies: { ...scoped, ...options.dependencies } });
  for (const [name, version] of Object.entries(options.installed ?? {})) {
    writePackage(join(cloneDir, "node_modules", ...name.split("/")), { name, version });
  }
}

// A library in the home's store, optionally declaring libraries of its own: that is what makes
// the closure readable without asking the registry.
function shareLibrary(home: string, specifier: string, version: string, requires: string[] = []): void {
  const dependencies = Object.fromEntries(requires.map((name) => [name, "^1.0.0"]));
  writePackage(join(home, "node_modules", ...specifier.split("/")), {
    name: specifier,
    version,
    ...(requires.length > 0 ? { dependencies } : {}),
  });
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

  // A shared library is only worth keeping while something needs it, so the answer to
  // "who needs this" comes from the clones rather than from a list kept alongside.
  it("names the plugins that declare each library", () => {
    const home = makeHome();
    shareLibrary(home, "@intisy-ai/core", "2.1.0");
    makeClone(home, "stub-auth", { libraries: ["@intisy-ai/core", "@intisy-ai/core-auth"] });
    makeClone(home, "wakatime-sync", { libraries: ["@intisy-ai/core"] });

    const core = sharedLibraries(home).find((l) => l.specifier === "@intisy-ai/core");
    expect(core?.usedBy).toEqual(["stub-auth", "wakatime-sync"]);
  });

  // A library nothing names directly still has a plugin behind it: npm installed it because
  // another library requires it. Crediting only the direct asks is how a load-bearing library
  // reads as left over and gets offered for removal.
  it("credits a library a plugin reaches only through another one", () => {
    const home = makeHome();
    shareLibrary(home, "@intisy-ai/core-proxy", "1.1.0", ["@intisy-ai/core-ir"]);
    shareLibrary(home, "@intisy-ai/core-ir", "1.0.3");
    makeClone(home, "claude-code-loader", { libraries: ["@intisy-ai/core-proxy"] });

    const ir = sharedLibraries(home).find((l) => l.specifier === "@intisy-ai/core-ir");
    expect(ir?.usedBy).toEqual(["claude-code-loader"]);
  });

  it("follows the closure more than one level deep", () => {
    const home = makeHome();
    shareLibrary(home, "@intisy-ai/core-proxy", "1.1.0", ["@intisy-ai/core-ir"]);
    shareLibrary(home, "@intisy-ai/core-ir", "1.0.3", ["@intisy-ai/api"]);
    shareLibrary(home, "@intisy-ai/api", "1.0.2");
    makeClone(home, "claude-code-loader", { libraries: ["@intisy-ai/core-proxy"] });

    const api = sharedLibraries(home).find((l) => l.specifier === "@intisy-ai/api");
    expect(api?.usedBy).toEqual(["claude-code-loader"]);
  });

  it("credits a plugin once when two of its libraries both require the same one", () => {
    const home = makeHome();
    shareLibrary(home, "@intisy-ai/core-auth", "1.1.0", ["@intisy-ai/core-ir"]);
    shareLibrary(home, "@intisy-ai/core-proxy", "1.1.0", ["@intisy-ai/core-ir"]);
    shareLibrary(home, "@intisy-ai/core-ir", "1.0.3");
    makeClone(home, "claude-code-loader", { libraries: ["@intisy-ai/core-auth", "@intisy-ai/core-proxy"] });

    const ir = sharedLibraries(home).find((l) => l.specifier === "@intisy-ai/core-ir");
    expect(ir?.usedBy).toEqual(["claude-code-loader"]);
  });

  // A cycle in the store's own metadata must not hang the walk.
  it("terminates when two libraries require each other", () => {
    const home = makeHome();
    shareLibrary(home, "@intisy-ai/left", "1.0.0", ["@intisy-ai/right"]);
    shareLibrary(home, "@intisy-ai/right", "1.0.0", ["@intisy-ai/left"]);
    makeClone(home, "example", { libraries: ["@intisy-ai/left"] });

    expect(sharedLibraries(home).map((l) => l.usedBy)).toEqual([["example"], ["example"]]);
  });

  it("is empty when the home has no store yet", () => {
    expect(sharedLibraries(makeHome())).toEqual([]);
  });
});

describe("pluginDependencies", () => {
  it("reports the version installed next to the plugin, not the range it asks for", () => {
    const home = makeHome();
    makeClone(home, "wakatime-sync", { dependencies: { undici: "^6.0.0" }, installed: { undici: "6.19.2" } });

    expect(pluginDependencies(home, "wakatime-sync")).toEqual([{ specifier: "undici", version: "6.19.2", usedBy: ["wakatime-sync"] }]);
  });

  // A dependency that never got installed is the one worth seeing, so it is listed rather
  // than quietly dropped for having no package.json to read.
  it("lists a declared dependency that is not installed", () => {
    const home = makeHome();
    makeClone(home, "wakatime-sync", { dependencies: { undici: "^6.0.0" } });

    expect(pluginDependencies(home, "wakatime-sync")).toEqual([{ specifier: "undici", version: "", usedBy: ["wakatime-sync"] }]);
  });

  // Named by what the plugin imports it by, never by the `name` inside the installed copy, so
  // one library can never be reported twice under two names.
  it("names a dependency by the specifier the plugin imports, not the installed copy's own name", () => {
    const home = makeHome();
    makeClone(home, "custom-auth", { libraries: ["@intisy-ai/core"] });
    writePackage(join(home, "repos", "custom-auth", "node_modules", "@intisy-ai", "core"), { name: "core", version: "2.0.0" });

    expect(pluginDependencies(home, "custom-auth")).toEqual([{ specifier: "@intisy-ai/core", version: "2.0.0", usedBy: ["custom-auth"] }]);
  });

  it("is empty for a plugin that declares none", () => {
    const home = makeHome();
    makeClone(home, "stub-auth");
    expect(pluginDependencies(home, "stub-auth")).toEqual([]);
  });
});

describe("homeLibraries", () => {
  it("puts the shared store alongside each plugin that has dependencies of its own", () => {
    const home = makeHome();
    shareLibrary(home, "@intisy-ai/core", "2.1.0");
    makeClone(home, "wakatime-sync", { libraries: ["@intisy-ai/core"], dependencies: { undici: "^6.0.0" }, installed: { undici: "6.19.2" } });
    makeClone(home, "stub-auth", { libraries: ["@intisy-ai/core"] });

    const result = homeLibraries(home);
    expect(result.shared).toEqual([{ specifier: "@intisy-ai/core", version: "2.1.0", usedBy: ["stub-auth", "wakatime-sync"] }]);
    expect(result.plugins).toEqual([
      { plugin: "stub-auth", dependencies: [{ specifier: "@intisy-ai/core", version: "", usedBy: ["stub-auth"] }] },
      {
        plugin: "wakatime-sync",
        dependencies: [
          { specifier: "@intisy-ai/core", version: "", usedBy: ["wakatime-sync"] },
          { specifier: "undici", version: "6.19.2", usedBy: ["wakatime-sync"] },
        ],
      },
    ]);
  });
});
