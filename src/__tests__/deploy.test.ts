// isLoaderPlugin decides whether deployToExecutionDir must call activate() after every
// deploy (loaders refresh their oc/cc wrapper) vs only under claude (see deploy.ts).
// It reads the clone's OWN cairn.json `app.loader.id`, not the shared app registry
// (registerAppFromClone only populates the registry AFTER deploy completes), so this
// locks in that manifest-reading behavior directly.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";
import { isLoaderPlugin, deployEntryFile, missingDeclaredArtifacts } from "../deploy.js";
import { declaredLibraries, materializeLibraries } from "../shared-libs.js";

describe("isLoaderPlugin", () => {
  let sourceDir: string;
  beforeEach(() => {
    sourceDir = mkdtempSync(join(tmpdir(), "pu-deploy-"));
  });
  afterEach(() => {
    rmSync(sourceDir, { recursive: true, force: true });
  });

  function writeManifest(manifest: unknown): void {
    writeFileSync(join(sourceDir, "cairn.json"), JSON.stringify(manifest));
  }

  it("returns true for a loader whose cairn.json app.loader.id matches its own plugin name", () => {
    // mirrors the real claude-code-loader cairn.json shape
    writeManifest({
      displayName: "Claude Code Loader",
      icon: "icon.svg",
      app: {
        id: "claude", label: "Claude Code",
        home: { envOverride: "HUB_CLAUDE_DIR", nativeEnv: "CLAUDE_CONFIG_DIR", candidates: ["~/.claude", "~/.config/claude"] },
        detect: { binary: "claude", pkg: "@anthropic-ai/claude-code" },
        loader: { id: "claude-code-loader", url: "intisy-ai/claude-code-loader" },
        commandsSubdir: "commands", proxyPort: 34567, integration: "env-baseurl", wireFormat: "anthropic",
      },
    });
    expect(isLoaderPlugin(sourceDir, "claude-code-loader")).toBe(true);
  });

  it("returns false for a non-loader plugin's manifest (no app block at all)", () => {
    writeManifest({ displayName: "Plain Plugin", icon: "icon.svg" });
    expect(isLoaderPlugin(sourceDir, "plain-plugin")).toBe(false);
  });

  it("returns false when app.loader.id is missing even though an app block is present", () => {
    writeManifest({
      displayName: "Almost Loader",
      app: {
        id: "demo", label: "Demo", home: { candidates: ["~/.demo"] },
        detect: { binary: "demo", pkg: "demo-cli" }, commandsSubdir: "commands",
        proxyPort: 0, integration: "env-baseurl", wireFormat: "generic",
      },
    });
    expect(isLoaderPlugin(sourceDir, "demo")).toBe(false);
  });

  it("returns false when app.loader.id names a DIFFERENT plugin than the one being checked", () => {
    writeManifest({
      app: { id: "claude", loader: { id: "claude-code-loader" } },
    });
    expect(isLoaderPlugin(sourceDir, "some-other-plugin")).toBe(false);
  });

  it("returns false when the clone has no cairn.json on disk", () => {
    expect(isLoaderPlugin(sourceDir, "claude-code-loader")).toBe(false);
  });

  it("returns false when cairn.json is malformed JSON", () => {
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "cairn.json"), "{ not valid json");
    expect(isLoaderPlugin(sourceDir, "claude-code-loader")).toBe(false);
  });
});

// A plugin is deployed as ONE file, so a repo whose npm entry is a multi-file tsc dist has
// to name a self-contained bundle for deployment; otherwise the deployed file imports
// siblings that were never copied and cannot even be loaded.
describe("deployEntryFile", () => {
  it("prefers the declared plugin entry over the npm main", () => {
    expect(deployEntryFile({ main: "dist/index.js", pluginEntry: "dist/plugin.js" })).toBe("dist/plugin.js");
  });

  it("falls back to the npm main when no plugin entry is declared", () => {
    expect(deployEntryFile({ main: "dist/bundle.js" })).toBe("dist/bundle.js");
  });

  it("falls back to index.js when the manifest names neither", () => {
    expect(deployEntryFile({})).toBe("index.js");
  });

  it("ignores a non-string plugin entry rather than deploying nonsense", () => {
    expect(deployEntryFile({ main: "dist/index.js", pluginEntry: 42 as never })).toBe("dist/index.js");
  });
});

describe("the deployed artifact", () => {
  // The artifact carries its own code but no longer its libraries, so it is exercised
  // the way a home actually holds it: the file beside the shared store the updater
  // materialises. Copying it somewhere with neither is not a deployment.
  it("answers config schema when deployed beside its shared libraries", () => {
    const home = mkdtempSync(join(tmpdir(), "pu-artifact-"));
    try {
      const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { pluginEntry?: string };
      const artifact = join(process.cwd(), pkg.pluginEntry ?? "dist/index.js");
      const pluginDir = join(home, "plugin");
      mkdirSync(pluginDir, { recursive: true });
      const copied = join(pluginDir, "plugin-updater.js");
      writeFileSync(join(pluginDir, "package.json"), JSON.stringify({ type: "module" }), "utf8");
      copyFileSync(artifact, copied);
      const shared = materializeLibraries(process.cwd(), home);
      // Scoped to what this plugin declares: the store also receives libraries nested inside those,
      // and one this artifact never imports may sit unbuilt in the checkout without breaking it.
      const declared = new Set(declaredLibraries(process.cwd()).map((library) => library.specifier));
      expect(shared.filter((r) => declared.has(r.specifier)).map((r) => r.specifier).sort())
        .toEqual(["@intisy-ai/core", "@intisy-ai/plugin-host"]);

      // api is NESTED under plugin-host rather than declared here, and its entry points live in
      // generated/ rather than dist/. The artifact imports it by name, so the store must have
      // carried both the nesting and the directory or the execFileSync below cannot even load.
      expect(existsSync(join(home, "node_modules", "@intisy-ai", "api", "generated", "engine.js"))).toBe(true);

      const out = execFileSync(process.execPath, [copied, "config", "schema"], { encoding: "utf8" });
      const schema = JSON.parse(out.trim()) as { name: string; fields?: unknown[] };
      expect(schema.name).toBe("plugin-updater");
      expect(Array.isArray(schema.fields)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30000);
});

// A provider whose handler never landed still loads its main entry, so "the deployed file
// exists" is not proof the build finished. Without this check the fast path skipped the
// rebuild forever and the provider's accounts stayed unreachable.
describe("missingDeclaredArtifacts", () => {
  let sourceDir: string;
  beforeEach(() => {
    sourceDir = mkdtempSync(join(tmpdir(), "pu-artifacts-"));
    mkdirSync(join(sourceDir, "dist"), { recursive: true });
  });
  afterEach(() => {
    rmSync(sourceDir, { recursive: true, force: true });
  });

  function writePkg(pkg: unknown): string {
    const at = join(sourceDir, "package.json");
    writeFileSync(at, JSON.stringify(pkg));
    return at;
  }

  const providerPkg = {
    main: "dist/index.js",
    claudeHub: { authProviders: [{ name: "claude-code", handler: "dist/handler.js" }] },
  };

  it("names a declared provider handler the build did not produce", () => {
    const pkgPath = writePkg(providerPkg);
    writeFileSync(join(sourceDir, "dist", "index.js"), "");
    expect(missingDeclaredArtifacts(sourceDir, pkgPath)).toEqual(["dist/handler.js"]);
  });

  it("reports nothing once every declared file is in place", () => {
    const pkgPath = writePkg(providerPkg);
    writeFileSync(join(sourceDir, "dist", "index.js"), "");
    writeFileSync(join(sourceDir, "dist", "handler.js"), "");
    expect(missingDeclaredArtifacts(sourceDir, pkgPath)).toEqual([]);
  });

  it("reads a top-level authProviders declaration too", () => {
    const pkgPath = writePkg({ main: "dist/index.js", authProviders: [{ handler: "dist/h.js" }] });
    writeFileSync(join(sourceDir, "dist", "index.js"), "");
    expect(missingDeclaredArtifacts(sourceDir, pkgPath)).toEqual(["dist/h.js"]);
  });

  it("holds no opinion about a plugin that declares nothing but its entry", () => {
    const pkgPath = writePkg({ main: "dist/index.js" });
    writeFileSync(join(sourceDir, "dist", "index.js"), "");
    expect(missingDeclaredArtifacts(sourceDir, pkgPath)).toEqual([]);
  });

  it("stays quiet on an unreadable package.json rather than claiming everything is missing", () => {
    writeFileSync(join(sourceDir, "package.json"), "{ not json");
    expect(missingDeclaredArtifacts(sourceDir, join(sourceDir, "package.json"))).toEqual([]);
  });

  // The library set comes from .gitmodules, the same source shared-libs uses, so a test that
  // seeds a library has to declare it as a submodule the way a real clone does.
  function writeLibrarySubmodule(dir: string, packageName: string, built: boolean): void {
    writeFileSync(join(sourceDir, ".gitmodules"), `[submodule "${dir}"]\n\tpath = ${dir}\n\turl = https://example/${dir}\n`);
    mkdirSync(join(sourceDir, dir), { recursive: true });
    writeFileSync(join(sourceDir, dir, "package.json"), JSON.stringify({ name: packageName, main: "dist/index.js" }));
    if (built) {
      mkdirSync(join(sourceDir, dir, "dist"), { recursive: true });
      writeFileSync(join(sourceDir, dir, "dist", "index.js"), "");
    }
  }

  function writeShippedFiles(handlerSource: string): void {
    writeFileSync(join(sourceDir, "dist", "index.js"), "");
    writeFileSync(join(sourceDir, "dist", "handler.js"), handlerSource);
  }

  it("names an unbuilt library the shipped handler still imports by name", () => {
    const pkgPath = writePkg(providerPkg);
    writeShippedFiles(`import { listAccounts } from "@intisy-ai/core-auth";`);
    writeLibrarySubmodule("core-auth", "@intisy-ai/core-auth", false);
    expect(missingDeclaredArtifacts(sourceDir, pkgPath)).toEqual(["core-auth/dist"]);
  });

  it("names it for a deep import of the same library", () => {
    const pkgPath = writePkg(providerPkg);
    writeShippedFiles(`import { listAccounts } from "@intisy-ai/core-auth/dist/accounts.js";`);
    writeLibrarySubmodule("core-auth", "@intisy-ai/core-auth", false);
    expect(missingDeclaredArtifacts(sourceDir, pkgPath)).toEqual(["core-auth/dist"]);
  });

  it("reports nothing once the library is built too", () => {
    const pkgPath = writePkg(providerPkg);
    writeShippedFiles(`import { listAccounts } from "@intisy-ai/core-auth";`);
    writeLibrarySubmodule("core-auth", "@intisy-ai/core-auth", true);
    expect(missingDeclaredArtifacts(sourceDir, pkgPath)).toEqual([]);
  });

  // A plugin that inlines its libraries runs fine with the submodule unbuilt, so calling
  // it broken would send every such plugin to a repair it does not need.
  it("holds no opinion about an unbuilt library the plugin inlined at build time", () => {
    const pkgPath = writePkg(providerPkg);
    writeShippedFiles(`function listAccounts() { return []; }`);
    writeLibrarySubmodule("core-auth", "@intisy-ai/core-auth", false);
    expect(missingDeclaredArtifacts(sourceDir, pkgPath)).toEqual([]);
  });

  it("holds no opinion about a clone that declares no submodules at all", () => {
    const pkgPath = writePkg(providerPkg);
    writeShippedFiles(`import { issuer } from "@openauthjs/openauth";`);
    expect(missingDeclaredArtifacts(sourceDir, pkgPath)).toEqual([]);
  });
});

// The pass that copies NOTHING is the one that matters: every existing home is already current, so
// a sidecar written only on a real deploy would never appear there at all.
describe("deployToExecutionDir on a home with nothing to deploy", () => {
  let home: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "pu-warm-"));
    for (const key of ["HUB_CONFIG_DIR", "PLUGIN_UPDATER_APP"]) saved[key] = process.env[key];
    process.env.HUB_CONFIG_DIR = home;
    process.env.PLUGIN_UPDATER_APP = "opencode";
  });
  afterEach(() => {
    for (const key of ["HUB_CONFIG_DIR", "PLUGIN_UPDATER_APP"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key] as string;
    }
    rmSync(home, { recursive: true, force: true });
  });

  it("writes the sidecar without building or copying anything", async () => {
    const { deployToExecutionDir } = await import("../deploy.js");
    const cloneDir = join(home, "repos", "warm");
    mkdirSync(join(cloneDir, "dist"), { recursive: true });
    writeFileSync(join(cloneDir, "package.json"), JSON.stringify({ name: "warm", main: "dist/index.js" }));
    writeFileSync(join(cloneDir, "dist", "index.js"), "export const activate = () => ({});\n");
    writeFileSync(join(cloneDir, "plugin.json"), JSON.stringify({ id: "warm", api: 1, entry: "dist/index.js" }));

    const pluginDir = join(home, "plugin");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, "warm.js"), "export const activate = () => ({});\n");

    await deployToExecutionDir("warm", pluginDir, false, home);

    expect(JSON.parse(readFileSync(join(pluginDir, "warm.json"), "utf8")).id).toBe("warm");
  });
});
