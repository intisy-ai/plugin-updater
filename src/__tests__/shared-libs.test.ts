import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { declaredLibraries, isVersionHigherThan, materializeLibraries, materializableLibraries, pruneAbandonedPluginStore, sharedStoreDir, submoduleTree, unbuiltLibraries } from "../shared-libs.js";

// ESM's "node:fs" namespace is non-configurable, so vi.spyOn can't touch rmSync directly.
// This mock passes every call straight through to the real fs, except rmSync while
// rmSyncFailure is armed, which lets one test simulate a locked file honestly.
let rmSyncFailure: Error | null = null;
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const rmSync: typeof actual.rmSync = (...args: Parameters<typeof actual.rmSync>) => {
    if (rmSyncFailure) throw rmSyncFailure;
    // @ts-expect-error - fs.rmSync overloads don't unify across the spread call
    return actual.rmSync(...args);
  };
  return { ...actual, rmSync, default: { ...actual.default, rmSync } };
});

let workDir: string | undefined;
afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  workDir = undefined;
});

function makeClone(submodules: Record<string, { name?: string; version?: string; type?: string; dist?: Record<string, string> }>): string {
  workDir = mkdtempSync(join(tmpdir(), "plugin-updater-shared-"));
  const sourceDir = join(workDir, "repos", "example");
  mkdirSync(sourceDir, { recursive: true });

  const entries = Object.keys(submodules);
  if (entries.length > 0) {
    const gitmodules = entries
      .map((path) => `[submodule "${path}"]\n\tpath = ${path}\n\turl = https://example.invalid/${path}\n`)
      .join("");
    writeFileSync(join(sourceDir, ".gitmodules"), gitmodules);
  }

  for (const [relative, spec] of Object.entries(submodules)) {
    const dir = join(sourceDir, relative);
    mkdirSync(dir, { recursive: true });
    if (spec.name !== undefined) {
      const pkg: Record<string, unknown> = { name: spec.name, version: spec.version ?? "1.0.0", main: "dist/index.js" };
      if (spec.type !== undefined) pkg.type = spec.type;
      writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
    }
    if (spec.dist) {
      mkdirSync(join(dir, "dist"), { recursive: true });
      for (const [file, content] of Object.entries(spec.dist)) writeFileSync(join(dir, "dist", file), content);
    }
  }
  return sourceDir;
}

describe("declaredLibraries", () => {
  it("reads the library set from .gitmodules and each submodule's package name", () => {
    const sourceDir = makeClone({ core: { name: "core" }, "core-auth": { name: "core-auth" } });
    expect(declaredLibraries(sourceDir).map((l) => l.specifier)).toEqual(["@intisy-ai/core", "@intisy-ai/core-auth"]);
  });

  it("keeps an already-scoped package name as-is", () => {
    const sourceDir = makeClone({ translator: { name: "@vendor/translator" } });
    expect(declaredLibraries(sourceDir)[0].specifier).toBe("@vendor/translator");
  });

  it("skips a submodule with no readable package name rather than guessing one", () => {
    const sourceDir = makeClone({ core: { name: "core" }, docs: {} });
    expect(declaredLibraries(sourceDir).map((l) => l.specifier)).toEqual(["@intisy-ai/core"]);
  });

  it("returns nothing for a clone carrying no submodules", () => {
    expect(declaredLibraries(makeClone({}))).toEqual([]);
  });
});

describe("submoduleTree", () => {
  it("lists every submodule the clone declares", () => {
    const sourceDir = makeClone({ core: { name: "core" }, "core-auth": { name: "core-auth" } });
    expect(submoduleTree(sourceDir)).toEqual(["core", "core-auth"]);
  });

  // A library carries libraries of its own (core-proxy nests core-ir), and each has a build
  // output the clone needs. A one-level read is what left those out of the copy-back.
  it("descends into a submodule that carries submodules of its own", () => {
    const sourceDir = makeClone({ "core-proxy": { name: "core-proxy" } });
    mkdirSync(join(sourceDir, "core-proxy", "core-ir"), { recursive: true });
    writeFileSync(
      join(sourceDir, "core-proxy", ".gitmodules"),
      `[submodule "core-ir"]\n\tpath = core-ir\n\turl = https://example.invalid/core-ir\n`,
    );
    expect(submoduleTree(sourceDir)).toEqual(["core-proxy", join("core-proxy", "core-ir")]);
  });

  it("returns nothing for a clone carrying no submodules", () => {
    expect(submoduleTree(makeClone({}))).toEqual([]);
  });
});

describe("isVersionHigherThan", () => {
  it("compares numerically rather than lexically", () => {
    expect(isVersionHigherThan("0.10.0", "0.9.9")).toBe(true);
    expect(isVersionHigherThan("0.9.9", "0.10.0")).toBe(false);
  });

  it("treats a higher leading segment as decisive regardless of the rest", () => {
    expect(isVersionHigherThan("1.0.0", "0.999.0")).toBe(true);
  });

  it("finds a plain segment-by-segment increase", () => {
    expect(isVersionHigherThan("0.3.3", "0.3.1")).toBe(true);
    expect(isVersionHigherThan("0.3.1", "0.3.3")).toBe(false);
  });

  it("treats equal versions as not higher", () => {
    expect(isVersionHigherThan("0.3.3", "0.3.3")).toBe(false);
  });

  it("treats a garbage or missing segment as 0 instead of throwing", () => {
    expect(isVersionHigherThan("1.x.0", "1.0.5")).toBe(false);
    expect(isVersionHigherThan("1.1.0", "1.x.5")).toBe(true);
    expect(isVersionHigherThan("1.0", "1.0.0")).toBe(false);
    expect(isVersionHigherThan("1.0.1", "1.0")).toBe(true);
    expect(() => isVersionHigherThan("", "")).not.toThrow();
  });
});

describe("materializeLibraries", () => {
  it("places a built library where Node resolves it from the deployed bundle", () => {
    const sourceDir = makeClone({ core: { name: "core", version: "0.3.0", dist: { "index.js": "export const x = 1;\n" } } });
    const configDir = join(workDir as string, "home");

    const results = materializeLibraries(sourceDir, configDir);

    expect(results).toEqual([{ specifier: "@intisy-ai/core", status: "written", detail: "0.3.0" }]);
    const target = join(sharedStoreDir(configDir), "@intisy-ai", "core");
    expect(readFileSync(join(target, "dist", "index.js"), "utf8")).toBe("export const x = 1;\n");
    expect(JSON.parse(readFileSync(join(target, "package.json"), "utf8"))).toEqual({
      name: "@intisy-ai/core",
      version: "0.3.0",
      main: "dist/index.js",
    });
  });

  // core-loader ships CommonJS and declares no "type" at all. Hardcoding "type": "module"
  // in the store made every one of its files unimportable ("exports is not defined in ES
  // module scope"), so the store must mirror what the library itself declares.
  it("mirrors type: module into the store when the source library declares it", () => {
    const sourceDir = makeClone({ core: { name: "core", type: "module", dist: { "index.js": "export const x = 1;\n" } } });
    const configDir = join(workDir as string, "home");

    materializeLibraries(sourceDir, configDir);

    const target = join(sharedStoreDir(configDir), "@intisy-ai", "core");
    expect(JSON.parse(readFileSync(join(target, "package.json"), "utf8"))).toMatchObject({ type: "module" });
  });

  it("writes no type key when the source library declares none (CommonJS)", () => {
    const sourceDir = makeClone({ "core-loader": { name: "core-loader", dist: { "index.js": "exports.x = 1;\n" } } });
    const configDir = join(workDir as string, "home");

    materializeLibraries(sourceDir, configDir);

    const target = join(sharedStoreDir(configDir), "@intisy-ai", "core-loader");
    const pkg = JSON.parse(readFileSync(join(target, "package.json"), "utf8")) as Record<string, unknown>;
    expect(pkg).not.toHaveProperty("type");
  });

  // Node resolves a bare specifier by walking UP from the importing file. The deployed
  // bundle sits at <home>/plugin/<name>.js and a provider's handler is loaded straight
  // out of its clone at <home>/repos/<name>/dist/, so a store under plugin/ was
  // invisible to the second and every provider failed to load. Both depths are
  // exercised by really importing, in a real node process, rather than by comparing paths.
  it("is resolvable from both a deployed bundle and a clone's handler", () => {
    const sourceDir = makeClone({ core: { name: "core", dist: { "index.js": "export const marker = 'shared';\n" } } });
    const configDir = join(workDir as string, "home");
    materializeLibraries(sourceDir, configDir);

    for (const importerDir of [join(configDir, "plugin"), join(configDir, "repos", "a-provider", "dist")]) {
      mkdirSync(importerDir, { recursive: true });
      const importer = join(importerDir, "entry.mjs");
      writeFileSync(importer, "import { marker } from '@intisy-ai/core';\nconsole.log(marker);\n");
      const out = execFileSync(process.execPath, [importer], { encoding: "utf8" }).trim();
      expect(out).toBe("shared");
    }
  });

  it("skips an unbuilt library instead of publishing an empty directory", () => {
    const sourceDir = makeClone({ core: { name: "core" } });
    const configDir = join(workDir as string, "home");
    expect(materializeLibraries(sourceDir, configDir)).toEqual([
      { specifier: "@intisy-ai/core", status: "skipped", detail: "not built" },
    ]);
  });

  it("replaces a previously shared copy rather than merging into it", () => {
    const sourceDir = makeClone({ core: { name: "core", dist: { "index.js": "new", "added.js": "added" } } });
    const configDir = join(workDir as string, "home");
    const target = join(sharedStoreDir(configDir), "@intisy-ai", "core");
    mkdirSync(join(target, "dist"), { recursive: true });
    writeFileSync(join(target, "dist", "stale.js"), "stale");

    materializeLibraries(sourceDir, configDir);

    expect(readFileSync(join(target, "dist", "index.js"), "utf8")).toBe("new");
    expect(() => readFileSync(join(target, "dist", "stale.js"), "utf8")).toThrow();
  });

  // The live defect: a store written by an older version of this function (which hardcoded
  // "type": "module") keeps failing to load a CommonJS library forever, because a version-only
  // check can't see that the store's metadata no longer matches what the source declares.
  it("rewrites a store entry whose type no longer matches the source, even though the version hasn't moved", () => {
    const sourceDir = makeClone({ "core-loader": { name: "core-loader", version: "1.3.2", dist: { "index.js": "exports.x = 1;\n" } } });
    const configDir = join(workDir as string, "home");
    const target = join(sharedStoreDir(configDir), "@intisy-ai", "core-loader");
    mkdirSync(join(target, "dist"), { recursive: true });
    writeFileSync(join(target, "dist", "index.js"), "exports.x = 1;\n");
    writeFileSync(
      join(target, "package.json"),
      JSON.stringify({ name: "@intisy-ai/core-loader", version: "1.3.2", type: "module", main: "dist/index.js" }),
    );

    const results = materializeLibraries(sourceDir, configDir);

    expect(results).toEqual([{ specifier: "@intisy-ai/core-loader", status: "written", detail: "1.3.2" }]);
    const pkg = JSON.parse(readFileSync(join(target, "package.json"), "utf8")) as Record<string, unknown>;
    expect(pkg).not.toHaveProperty("type");
  });

  it("treats a store entry as current, and leaves it untouched, when it matches the source in every synthesized field", () => {
    const sourceDir = makeClone({ core: { name: "core", version: "0.3.3", dist: { "index.js": "export const x = 1;\n" } } });
    const configDir = join(workDir as string, "home");
    const target = join(sharedStoreDir(configDir), "@intisy-ai", "core");
    mkdirSync(join(target, "dist"), { recursive: true });
    writeFileSync(join(target, "dist", "index.js"), "export const x = 1;\n");
    writeFileSync(join(target, "package.json"), JSON.stringify({ name: "@intisy-ai/core", version: "0.3.3", main: "dist/index.js" }));
    const marker = join(target, "marker.txt");
    writeFileSync(marker, "untouched");

    const results = materializeLibraries(sourceDir, configDir);

    expect(results).toEqual([{ specifier: "@intisy-ai/core", status: "current", detail: "0.3.3" }]);
    expect(readFileSync(marker, "utf8")).toBe("untouched");
  });

  // The measured defect: four plugin clones disagree on core's version, and whichever
  // deploys last used to win regardless of whether it was a downgrade.
  it("leaves a higher store version alone when a clone offers a lower one", () => {
    const sourceDir = makeClone({ core: { name: "core", version: "0.3.1", dist: { "index.js": "old" } } });
    const configDir = join(workDir as string, "home");
    const target = join(sharedStoreDir(configDir), "@intisy-ai", "core");
    mkdirSync(join(target, "dist"), { recursive: true });
    writeFileSync(join(target, "dist", "index.js"), "export const x = 1;\n");
    writeFileSync(join(target, "package.json"), JSON.stringify({ name: "@intisy-ai/core", version: "0.3.3", main: "dist/index.js" }));
    const marker = join(target, "marker.txt");
    writeFileSync(marker, "untouched");

    const results = materializeLibraries(sourceDir, configDir);

    expect(results).toEqual([{ specifier: "@intisy-ai/core", status: "skipped", detail: "kept 0.3.3 over 0.3.1" }]);
    expect(JSON.parse(readFileSync(join(target, "package.json"), "utf8"))).toMatchObject({ version: "0.3.3" });
    expect(readFileSync(marker, "utf8")).toBe("untouched");
  });

  it("overwrites a lower store version when a clone offers a higher one", () => {
    const sourceDir = makeClone({ core: { name: "core", version: "0.3.3", dist: { "index.js": "new" } } });
    const configDir = join(workDir as string, "home");
    const target = join(sharedStoreDir(configDir), "@intisy-ai", "core");
    mkdirSync(join(target, "dist"), { recursive: true });
    writeFileSync(join(target, "dist", "index.js"), "old");
    writeFileSync(join(target, "package.json"), JSON.stringify({ name: "@intisy-ai/core", version: "0.3.1", main: "dist/index.js" }));

    const results = materializeLibraries(sourceDir, configDir);

    expect(results).toEqual([{ specifier: "@intisy-ai/core", status: "written", detail: "0.3.3" }]);
    expect(readFileSync(join(target, "dist", "index.js"), "utf8")).toBe("new");
    expect(JSON.parse(readFileSync(join(target, "package.json"), "utf8"))).toMatchObject({ version: "0.3.3" });
  });

  it("copies nested directories inside the library's dist", () => {
    const sourceDir = makeClone({ core: { name: "core", dist: { "index.js": "root" } } });
    mkdirSync(join(sourceDir, "core", "dist", "generated"), { recursive: true });
    writeFileSync(join(sourceDir, "core", "dist", "generated", "teavm.js"), "nested");
    const configDir = join(workDir as string, "home");

    materializeLibraries(sourceDir, configDir);

    const target = join(sharedStoreDir(configDir), "@intisy-ai", "core");
    expect(readFileSync(join(target, "dist", "generated", "teavm.js"), "utf8")).toBe("nested");
  });
});

// A home whose clones predate a library becoming shared never repaired itself: the deploy fast
// path skipped the build because the deployed file was already there, so the library's dist was
// never produced, so materialising it was skipped forever and the provider could not load.
describe("unbuiltLibraries", () => {
  it("names a declared library that has no build output", () => {
    const sourceDir = makeClone({
      core: { name: "core", dist: { "index.js": "x" } },
      "core-auth": { name: "core-auth" },
    });
    expect(unbuiltLibraries(sourceDir).map((l) => l.specifier)).toEqual(["@intisy-ai/core-auth"]);
  });

  it("is empty once every declared library is built", () => {
    const sourceDir = makeClone({
      core: { name: "core", dist: { "index.js": "x" } },
      "core-auth": { name: "core-auth", dist: { "index.js": "y" } },
    });
    expect(unbuiltLibraries(sourceDir)).toEqual([]);
  });

  it("is empty for a clone that declares no libraries", () => {
    expect(unbuiltLibraries(makeClone({}))).toEqual([]);
  });
});

describe("materialising a nested library", () => {
  let home: string;
  let clone: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "pu-store-"));
    clone = join(home, "repos", "demo");
    mkdirSync(clone, { recursive: true });
  });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  function library(relative: string, name: string, version: string, submodules: string[] = []): void {
    const dir = join(clone, relative);
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version, main: "dist/index.js" }));
    writeFileSync(join(dir, "dist", "index.js"), "export const x = 1;\n");
    if (submodules.length) {
      writeFileSync(join(dir, ".gitmodules"), submodules.map((path) => `[submodule "${path}"]\n\tpath = ${path}\n`).join(""));
    }
  }

  it("puts a library nested under another submodule into the store", () => {
    writeFileSync(join(clone, ".gitmodules"), '[submodule "core"]\n\tpath = core\n');
    library("core", "core", "0.3.3", ["api"]);
    library(join("core", "api"), "api", "0.2.0");

    const results = materializeLibraries(clone, home);

    expect(results.map((result) => result.specifier).sort()).toEqual(["@intisy-ai/api", "@intisy-ai/core"]);
    expect(existsSync(join(home, "node_modules", "@intisy-ai", "api", "dist", "index.js"))).toBe(true);
    expect(JSON.parse(readFileSync(join(home, "node_modules", "@intisy-ai", "api", "package.json"), "utf8"))).toMatchObject({
      name: "@intisy-ai/api", version: "0.2.0", main: "dist/index.js",
    });
  });

  it("materialises one library once when two submodules carry it", () => {
    writeFileSync(join(clone, ".gitmodules"), '[submodule "core"]\n\tpath = core\n[submodule "core-loader"]\n\tpath = core-loader\n');
    library("core", "core", "0.3.3", ["api"]);
    library(join("core", "api"), "api", "0.2.0");
    library("core-loader", "core-loader", "1.3.2", ["api"]);
    library(join("core-loader", "api"), "api", "0.2.0");

    const results = materializeLibraries(clone, home);

    expect(results.filter((result) => result.specifier === "@intisy-ai/api")).toHaveLength(1);
  });
});

// <home>/plugin/node_modules is a store this plugin wrote before the store moved to
// <home>/node_modules. Node resolves the CLOSER directory first from a bundle at
// <home>/plugin/<id>.js, so a stale copy left there silently shadows the real store forever.
describe("pruneAbandonedPluginStore", () => {
  let home: string;
  let pluginDir: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "pu-prune-"));
    pluginDir = join(home, "plugin");
    mkdirSync(pluginDir, { recursive: true });
  });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  function seedAbandonedStore(): string {
    const abandoned = join(pluginDir, "node_modules", "@intisy-ai", "core");
    mkdirSync(abandoned, { recursive: true });
    writeFileSync(join(abandoned, "package.json"), JSON.stringify({ name: "@intisy-ai/core", version: "0.3.1" }));
    return join(pluginDir, "node_modules");
  }

  function seedRealStore(): string {
    const real = join(home, "node_modules", "@intisy-ai", "core");
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "package.json"), JSON.stringify({ name: "@intisy-ai/core", version: "0.3.3" }));
    return join(home, "node_modules");
  }

  it("removes the abandoned plugin-directory store once the real store is populated", () => {
    const abandoned = seedAbandonedStore();
    seedRealStore();

    pruneAbandonedPluginStore(pluginDir, home);

    expect(existsSync(abandoned)).toBe(false);
  });

  it("logs the removal through the provided writeLog", () => {
    const abandoned = seedAbandonedStore();
    seedRealStore();
    const logged: string[] = [];

    pruneAbandonedPluginStore(pluginDir, home, (message) => logged.push(message));

    expect(existsSync(abandoned)).toBe(false);
    expect(logged.some((message) => message.includes(abandoned))).toBe(true);
  });

  it("does not remove the abandoned store when the real store is empty", () => {
    const abandoned = seedAbandonedStore();
    mkdirSync(join(home, "node_modules"), { recursive: true });

    pruneAbandonedPluginStore(pluginDir, home);

    expect(existsSync(abandoned)).toBe(true);
  });

  it("does not remove the abandoned store when the real store does not exist", () => {
    const abandoned = seedAbandonedStore();

    pruneAbandonedPluginStore(pluginDir, home);

    expect(existsSync(abandoned)).toBe(true);
  });

  it("never touches the real store", () => {
    seedAbandonedStore();
    const real = seedRealStore();
    const realPackageJson = join(real, "@intisy-ai", "core", "package.json");
    const before = readFileSync(realPackageJson, "utf8");

    pruneAbandonedPluginStore(pluginDir, home);

    expect(existsSync(real)).toBe(true);
    expect(readFileSync(realPackageJson, "utf8")).toBe(before);
  });

  it("does nothing when there is no abandoned store to begin with", () => {
    seedRealStore();
    expect(() => pruneAbandonedPluginStore(pluginDir, home)).not.toThrow();
    expect(existsSync(join(pluginDir, "node_modules"))).toBe(false);
  });

  // A locked file on Windows must never fail the caller's deploy/repair; it is retried
  // on the next pass instead. This exercises that containment honestly, by making the
  // removal itself fail rather than by simulating a real OS-level lock.
  it("survives fs.rmSync throwing and reports the failure through writeLog", () => {
    const abandoned = seedAbandonedStore();
    seedRealStore();
    rmSyncFailure = new Error("EBUSY: resource busy or locked");
    const logged: Array<{ message: string; isError?: boolean }> = [];

    try {
      expect(() => pruneAbandonedPluginStore(pluginDir, home, (message, isError) => logged.push({ message, isError }))).not.toThrow();
    } finally {
      rmSyncFailure = null;
    }

    expect(existsSync(abandoned)).toBe(true);
    const failure = logged.find((entry) => entry.message.includes(abandoned));
    expect(failure).toMatchObject({ isError: true });
    expect(failure?.message).toContain("EBUSY");
  });
});
