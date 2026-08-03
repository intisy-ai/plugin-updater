// isLoaderPlugin decides whether deployToExecutionDir must call activate() after every
// deploy (loaders refresh their oc/cc wrapper) vs only under claude (see deploy.ts).
// It reads the clone's OWN cairn.json `app.loader.id`, not the shared app registry
// (registerAppFromClone only populates the registry AFTER deploy completes), so this
// locks in that manifest-reading behavior directly.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { isLoaderPlugin } from "../deploy.js";

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
