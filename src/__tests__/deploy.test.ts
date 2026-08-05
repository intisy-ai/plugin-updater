// isLoaderPlugin decides whether deployToExecutionDir must call activate() after every
// deploy (loaders refresh their oc/cc wrapper) vs only under claude (see deploy.ts).
// It reads the clone's OWN cairn.json `app.loader.id`, not the shared app registry
// (registerAppFromClone only populates the registry AFTER deploy completes), so this
// locks in that manifest-reading behavior directly.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";
import { isLoaderPlugin, deployEntryFile } from "../deploy.js";

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
  it("answers config schema after being copied out on its own", () => {
    const isolated = mkdtempSync(join(tmpdir(), "pu-artifact-"));
    try {
      const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { pluginEntry?: string };
      const artifact = join(process.cwd(), pkg.pluginEntry ?? "dist/index.js");
      const copied = join(isolated, "plugin-updater.js");
      writeFileSync(join(isolated, "package.json"), JSON.stringify({ type: "module" }), "utf8");
      copyFileSync(artifact, copied);

      const out = execFileSync(process.execPath, [copied, "config", "schema"], { encoding: "utf8" });
      const schema = JSON.parse(out.trim()) as { name: string; fields?: unknown[] };
      expect(schema.name).toBe("plugin-updater");
      expect(Array.isArray(schema.fields)).toBe(true);
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  }, 30000);
});
