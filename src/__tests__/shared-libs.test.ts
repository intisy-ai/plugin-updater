import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { declaredLibraries, materializeLibraries, sharedStoreDir, submoduleTree, unbuiltLibraries } from "../shared-libs.js";

let workDir: string | undefined;
afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  workDir = undefined;
});

function makeClone(submodules: Record<string, { name?: string; version?: string; dist?: Record<string, string> }>): string {
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
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: spec.name, version: spec.version ?? "1.0.0", main: "dist/index.js" }));
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
      type: "module",
      main: "dist/index.js",
    });
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
