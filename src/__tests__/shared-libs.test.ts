import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { declaredLibraries, materializeLibraries, sharedStoreDir } from "../shared-libs.js";

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
