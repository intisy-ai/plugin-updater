// Integration test for the earlyLaunch update-status cache writer: a real git clone
// that is behind its remote must be flagged updateAvailable:true (even with
// autoUpdate:false — the remote is still checked, only the pull is skipped), and a
// clone that stays current after its normal pull must be flagged false.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execSync } from "child_process";
import type { Plugin } from "../types.js";

function git(cmd: string, cwd: string): void {
  execSync(cmd, { cwd, stdio: "ignore" });
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git("git init -b main", dir);
  git('git config user.email "test@test.com"', dir);
  git('git config user.name "test"', dir);
  writeFileSync(join(dir, "file.txt"), "one", "utf8");
  git("git add .", dir);
  git('git -c commit.gpgsign=false commit -m "first"', dir);
}

function commitMore(dir: string, content: string): void {
  writeFileSync(join(dir, "file.txt"), content, "utf8");
  git("git add .", dir);
  git('git -c commit.gpgsign=false commit -m "more"', dir);
}

const ENV_KEYS = ["HUB_CONFIG_DIR", "HUB_CLAUDE_DIR", "HUB_OPENCODE_DIR", "CORE_APP", "PLUGIN_UPDATER_APP", "PLUGIN_UPDATER_LIBRARY_MODE"];

describe("earlyLaunch update-status cache", () => {
  let configDir: string;
  let originsRoot: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "pu-cache-cfg-"));
    originsRoot = mkdtempSync(join(tmpdir(), "pu-cache-origin-"));
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    // isolate every config-dir-resolving path (core's + plugin-updater's own) to the
    // fake configDir, and point the OTHER app's dirs at a path that never exists so
    // deployUpdaterCommands()'s cross-app fan-out touches nothing real.
    process.env.HUB_CONFIG_DIR = configDir;
    process.env.HUB_OPENCODE_DIR = configDir;
    process.env.HUB_CLAUDE_DIR = join(tmpdir(), `pu-cache-noop-claude-${Date.now()}`);
    process.env.CORE_APP = "opencode";
    process.env.PLUGIN_UPDATER_APP = "opencode";
    // must be set before index.ts's module-level self-activation IIFE runs
    process.env.PLUGIN_UPDATER_LIBRARY_MODE = "1";

    mkdirSync(join(configDir, "config"), { recursive: true });
    writeFileSync(join(configDir, "config", "plugin-updater.json"), JSON.stringify({ self_update: false }), "utf8");
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    rmSync(configDir, { recursive: true, force: true });
    rmSync(originsRoot, { recursive: true, force: true });
  });

  it("flags a behind clone (autoUpdate:false) as updateAvailable:true and an up-to-date one as false", async () => {
    const reposDir = join(configDir, "repos");
    mkdirSync(reposDir, { recursive: true });

    const behindOrigin = join(originsRoot, "behind-origin");
    initRepo(behindOrigin);
    git(`git clone --branch main "${behindOrigin}" "behind-plugin"`, reposDir);
    commitMore(behindOrigin, "two"); // origin moves ahead of the already-made clone

    const uptodateOrigin = join(originsRoot, "uptodate-origin");
    initRepo(uptodateOrigin);
    git(`git clone --branch main "${uptodateOrigin}" "uptodate-plugin"`, reposDir);
    // no further commits — the clone stays current through earlyLaunch's normal pull

    const plugins: Plugin[] = [
      { name: "behind-plugin", url: behindOrigin, branch: "main", enabled: true, autoUpdate: false },
      { name: "uptodate-plugin", url: uptodateOrigin, branch: "main", enabled: true, autoUpdate: true },
    ];
    writeFileSync(join(configDir, "config", "plugins.json"), JSON.stringify(plugins, null, 2), "utf8");

    const { earlyLaunch } = await import("../index.js");
    await earlyLaunch(configDir, plugins);

    const cache = JSON.parse(readFileSync(join(configDir, "cache", "plugin-updates.json"), "utf8"));

    const behind = cache.plugins["behind-plugin"];
    expect(behind.kind).toBe("git");
    expect(behind.localHead).toBeTruthy();
    expect(behind.remoteHead).toBeTruthy();
    expect(behind.localHead).not.toBe(behind.remoteHead);
    expect(behind.updateAvailable).toBe(true);

    const upToDate = cache.plugins["uptodate-plugin"];
    expect(upToDate.kind).toBe("git");
    expect(upToDate.localHead).toBeTruthy();
    expect(upToDate.localHead).toBe(upToDate.remoteHead);
    expect(upToDate.updateAvailable).toBe(false);
  });
});
