// A loader's installed clone carries its app descriptor in cairn.json; on install
// plugin-updater registers that block into the shared app registry so a dashboard
// discovers apps from the loaders on disk, without a hardcoded app list.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { registerAppFromClone } from "../index.js";

describe("registerAppFromClone", () => {
  let repos: string, appsFile: string, savedAppsFile: string | undefined;
  beforeEach(() => {
    repos = mkdtempSync(join(tmpdir(), "pu-repos-"));
    appsFile = join(mkdtempSync(join(tmpdir(), "pu-apps-")), "apps.json");
    savedAppsFile = process.env.HUB_APPS_FILE;
    process.env.HUB_APPS_FILE = appsFile;
  });
  afterEach(() => {
    if (savedAppsFile === undefined) delete process.env.HUB_APPS_FILE;
    else process.env.HUB_APPS_FILE = savedAppsFile;
    rmSync(repos, { recursive: true, force: true });
  });

  function writeManifest(name: string, manifest: unknown): void {
    const dir = join(repos, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "cairn.json"), JSON.stringify(manifest));
  }

  it("registers a loader's app block into the shared registry", () => {
    writeManifest("demo-loader", {
      displayName: "Demo Loader",
      icon: "icon.svg",
      app: {
        id: "demo", label: "Demo", home: { candidates: ["~/.demo"] },
        detect: { binary: "demo", pkg: "demo-cli" }, commandsSubdir: "commands",
        proxyPort: 0, integration: "env-baseurl", wireFormat: "generic",
      },
    });
    registerAppFromClone("demo-loader", repos);
    const written = JSON.parse(readFileSync(appsFile, "utf8")) as Record<string, { id?: string; label?: string }>;
    expect(written.demo?.id).toBe("demo");
    expect(written.demo?.label).toBe("Demo");
  });

  it("registers nothing for a plugin without an app block", () => {
    writeManifest("plain-plugin", { displayName: "Plain" });
    registerAppFromClone("plain-plugin", repos);
    expect(existsSync(appsFile)).toBe(false);
  });

  it("does not throw when the clone has no manifest on disk", () => {
    expect(() => registerAppFromClone("missing", repos)).not.toThrow();
    expect(existsSync(appsFile)).toBe(false);
  });
});
