// Integration test for plugin-updater's install/update/failure activity emits.
// Drives the real update path (updatePluginPublic) against a temp git origin and
// reads back the resulting activity from core's event bus in an isolated temp home.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execSync } from "child_process";
// @ts-ignore: generated bundle, no .d.ts
import { readActivity } from "@intisy-ai/core";
import { getPlugins, getPluginsPath } from "../config.js";
import { setEarlyLaunchConfigDir } from "../env.js";

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
    // the early-launch dir is module state that outlives one test, so each test points
    // it at its own home the way a fresh process would
    setEarlyLaunchConfigDir(configDir);
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
    expect(rec.outcome).toBe("ok");
    expect(rec.subject).toEqual({ kind: "plugin", id: "install-demo", label: "install-demo" });
  }, 60000);

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
    expect(rec.outcome).toBe("ok");
  }, 60000);

  it("emits an update_failed activity (impact error) when the update fails", async () => {
    const missingOrigin = join(originsRoot, "does-not-exist");

    const { updatePluginPublic } = await import("../index.js");
    await expect(updatePluginPublic("broken-demo", missingOrigin, "main")).rejects.toThrow();

    const { records } = readActivity([configDir], { topics: ["plugin.installed"] });
    const rec = records.find((r: { action: string }) => r.action === "update_failed");
    expect(rec).toBeDefined();
    expect(rec.impact).toBe("error");
    expect(rec.outcome).toBe("failed");
  }, 60000);

  it("reports one activation per plugin this home loads, and none for a disabled one", async () => {
    const enabledOrigin = join(originsRoot, "origin-enabled");
    initRepo(enabledOrigin);
    const disabledOrigin = join(originsRoot, "origin-disabled");
    initRepo(disabledOrigin);
    writeFileSync(getPluginsPath(configDir), JSON.stringify([
      { name: "enabled-demo", url: enabledOrigin, branch: "main", enabled: true, autoUpdate: true },
      { name: "disabled-demo", url: disabledOrigin, branch: "main", enabled: false, autoUpdate: true },
    ]), "utf8");

    const { earlyLaunch } = await import("../index.js");
    await earlyLaunch(configDir, getPlugins(configDir));

    const { records } = readActivity([configDir], { topics: ["plugin.activated"] });
    expect(records.map((r: { subject: { id: string } }) => r.subject.id)).toEqual(["enabled-demo"]);
    const [rec] = records;
    expect(rec.action).toBe("activated");
    expect(rec.actor).toBe("app");
    expect(rec.impact).toBe("info");
    expect(rec.cause.kind).toBe("startup");
    expect(rec.details.kind).toBe("git");
    expect(rec.origin.entry).toBe("updater");
    expect(rec.origin.home).toBe(configDir);
  }, 30000);

  it("does not send a later home's records to the home a previous run used", async () => {
    const firstOrigin = join(originsRoot, "origin-first-home");
    initRepo(firstOrigin);
    writeFileSync(getPluginsPath(configDir), JSON.stringify([
      { name: "first-home-demo", url: firstOrigin, branch: "main", enabled: true },
    ]), "utf8");

    const { earlyLaunch, uninstallPlugin } = await import("../index.js");
    await earlyLaunch(configDir, getPlugins(configDir));

    const secondHome = mkdtempSync(join(tmpdir(), "pu-activity-second-"));
    try {
      process.env.HUB_CONFIG_DIR = secondHome;
      process.env.HUB_OPENCODE_DIR = secondHome;
      mkdirSync(join(secondHome, "config"), { recursive: true });
      writeFileSync(getPluginsPath(secondHome), JSON.stringify([
        { name: "second-home-demo", url: firstOrigin, enabled: true },
      ]), "utf8");
      uninstallPlugin(secondHome, "second-home-demo");

      const inSecond = readActivity([secondHome], { topics: ["plugin.installed"] }).records;
      expect(inSecond.map((r: { action: string }) => r.action)).toContain("uninstalled");
      const inFirst = readActivity([configDir], { topics: ["plugin.installed"] }).records;
      expect(inFirst.map((r: { action: string }) => r.action)).not.toContain("uninstalled");
    } finally {
      rmSync(secondHome, { recursive: true, force: true });
    }
  }, 30000);

  it("reports an uninstall as a notice", async () => {
    writeFileSync(getPluginsPath(configDir), JSON.stringify([
      { name: "gone-demo", url: join(originsRoot, "whatever"), enabled: true },
    ]), "utf8");

    const { uninstallPlugin } = await import("../index.js");
    uninstallPlugin(configDir, "gone-demo");

    const { records } = readActivity([configDir], { topics: ["plugin.installed"] });
    const rec = records.find((r: { action: string }) => r.action === "uninstalled");
    expect(rec).toBeDefined();
    expect(rec.impact).toBe("notice");
    expect(rec.outcome).toBe("ok");
    expect(rec.subject.id).toBe("gone-demo");
    // an uninstall says what it removed, not just that something happened
    expect(rec.details.kind).toBe("git");
    expect(rec.details.url).toContain("whatever");
    expect(rec.text).toContain("gone-demo");
  });

it("records an uninstall in the home it was performed on, even when the process points elsewhere", async () => {
    const otherHome = mkdtempSync(join(tmpdir(), "pu-activity-elsewhere-"));
    try {
      mkdirSync(join(otherHome, "config"), { recursive: true });
      writeFileSync(getPluginsPath(otherHome), JSON.stringify([
        { name: "away-demo", url: join(originsRoot, "away"), enabled: true },
      ]), "utf8");

      // the process home stays configDir while the work targets otherHome, which is what
      // a dashboard does when it manages another app's home in-process
      const { uninstallPlugin } = await import("../index.js");
      uninstallPlugin(otherHome, "away-demo");

      const here = readActivity([configDir], { topics: ["plugin.installed"] }).records;
      const there = readActivity([otherHome], { topics: ["plugin.installed"] }).records;
      expect(there.map((r: { action: string }) => r.action)).toContain("uninstalled");
      expect(here.map((r: { action: string }) => r.action)).not.toContain("uninstalled");
    } finally {
      rmSync(otherHome, { recursive: true, force: true });
    }
  });

  it("reports a downgrade with the commit it pinned", async () => {
    const origin = join(originsRoot, "origin-downgrade");
    const firstHash = initRepo(origin);
    git(`git clone --branch main "${origin}" "downgrade-demo"`, join(configDir, "repos"));
    commitMore(origin, "two");

    const { downgrade } = await import("../index.js");
    expect(downgrade({ name: "downgrade-demo", url: origin, branch: "main" }, firstHash)).toBe("");

    const { records } = readActivity([configDir], { topics: ["plugin.installed"] });
    const rec = records.find((r: { action: string }) => r.action === "downgraded");
    expect(rec).toBeDefined();
    expect(rec.impact).toBe("notice");
    expect(rec.outcome).toBe("ok");
    expect(rec.details.hash).toBe(firstHash);
  }, 60000);
});
