// Integration test for plugin-updater's install/update/failure activity emits.
// Drives the real update path (updatePluginPublic) against a temp git origin and
// reads back the resulting activity from core's event bus in an isolated temp home.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execSync } from "child_process";
// @ts-ignore: generated bundle, no .d.ts
import { readActivity } from "../../lib/core.js";

function git(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd }).toString().trim();
}

function initRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  git("git init -b main", dir);
  git('git config user.email "test@test.com"', dir);
  git('git config user.name "test"', dir);
  writeFileSync(join(dir, "file.txt"), "one", "utf8");
  git("git add .", dir);
  git('git -c commit.gpgsign=false commit -m "first"', dir);
  return git("git rev-parse HEAD", dir);
}

function commitMore(dir: string, content: string): string {
  writeFileSync(join(dir, "file.txt"), content, "utf8");
  git("git add .", dir);
  git('git -c commit.gpgsign=false commit -m "more"', dir);
  return git("git rev-parse HEAD", dir);
}

const ENV_KEYS = ["HUB_CONFIG_DIR", "HUB_CLAUDE_DIR", "HUB_OPENCODE_DIR", "CORE_APP", "PLUGIN_UPDATER_APP", "PLUGIN_UPDATER_LIBRARY_MODE"];

describe("plugin-updater install/update/failure activity", () => {
  let configDir: string;
  let originsRoot: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "pu-activity-cfg-"));
    originsRoot = mkdtempSync(join(tmpdir(), "pu-activity-origin-"));
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    process.env.HUB_CONFIG_DIR = configDir;
    process.env.HUB_OPENCODE_DIR = configDir;
    process.env.HUB_CLAUDE_DIR = join(tmpdir(), `pu-activity-noop-claude-${Date.now()}`);
    process.env.CORE_APP = "opencode";
    process.env.PLUGIN_UPDATER_APP = "opencode";
    // must be set before index.ts's module-level self-activation IIFE runs
    process.env.PLUGIN_UPDATER_LIBRARY_MODE = "1";

    mkdirSync(join(configDir, "config"), { recursive: true });
    writeFileSync(join(configDir, "config", "plugin-updater.json"), JSON.stringify({ self_update: false }), "utf8");
    mkdirSync(join(configDir, "repos"), { recursive: true });
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    rmSync(configDir, { recursive: true, force: true });
    rmSync(originsRoot, { recursive: true, force: true });
  });

  it("emits an installed activity on a fresh clone", async () => {
    const origin = join(originsRoot, "origin-install");
    const firstHash = initRepo(origin);

    const { updatePluginPublic } = await import("../index.js");
    await updatePluginPublic("install-demo", origin, "main");

    const { records } = readActivity([configDir], { topics: ["plugin.installed"] });
    const rec = records.find((r: { action: string }) => r.action === "installed");
    expect(rec).toBeDefined();
    expect(rec.details.version).toBe(firstHash);
    expect(rec.subject).toEqual({ kind: "plugin", id: "install-demo", label: "install-demo" });
  }, 20000);

  it("emits an updated activity with the version delta on a successful update", async () => {
    const origin = join(originsRoot, "origin-update");
    const firstHash = initRepo(origin);
    git(`git clone --branch main "${origin}" "update-demo"`, join(configDir, "repos"));
    const secondHash = commitMore(origin, "two");

    const { updatePluginPublic } = await import("../index.js");
    await updatePluginPublic("update-demo", origin, "main");

    const { records } = readActivity([configDir], { topics: ["plugin.installed"] });
    const rec = records.find((r: { action: string }) => r.action === "updated");
    expect(rec).toBeDefined();
    expect(rec.details.fromVersion).toBe(firstHash);
    expect(rec.details.toVersion).toBe(secondHash);
  }, 20000);

  it("emits an update_failed activity (impact error) when the update fails", async () => {
    const missingOrigin = join(originsRoot, "does-not-exist");

    const { updatePluginPublic } = await import("../index.js");
    await expect(updatePluginPublic("broken-demo", missingOrigin, "main")).rejects.toThrow();

    const { records } = readActivity([configDir], { topics: ["plugin.installed"] });
    const rec = records.find((r: { action: string }) => r.action === "update_failed");
    expect(rec).toBeDefined();
    expect(rec.impact).toBe("error");
  }, 20000);
});
