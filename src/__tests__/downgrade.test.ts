// Integration test for FIX 1: core-loader's downgrade TUI action calls
// `updater.downgrade(repo, commitHash)` synchronously and expects a string return
// ("" = ok). It must persist the pin (plugins.json commitHash) so the NEXT
// earlyLaunch honors it instead of reverting to a normal branch pull; and a plain
// updatePluginPublic() call with no commitHash must clear that pin again.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execSync } from "child_process";
import type { Plugin } from "../types.js";

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

describe("downgrade + pin reversibility", () => {
  let configDir: string;
  let originsRoot: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "pu-downgrade-cfg-"));
    originsRoot = mkdtempSync(join(tmpdir(), "pu-downgrade-origin-"));
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    process.env.HUB_CONFIG_DIR = configDir;
    process.env.HUB_OPENCODE_DIR = configDir;
    process.env.HUB_CLAUDE_DIR = join(tmpdir(), `pu-downgrade-noop-claude-${Date.now()}`);
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

  it("downgrade() checks out and persists commitHash; a later plain update clears it", async () => {
    const reposDir = join(configDir, "repos");
    mkdirSync(reposDir, { recursive: true });

    const origin = join(originsRoot, "origin");
    const firstHash = initRepo(origin);
    const secondHash = commitMore(origin, "two");
    git(`git clone --branch main "${origin}" "demo-plugin"`, reposDir);

    const plugin: Plugin = { name: "demo-plugin", url: origin, branch: "main", enabled: true };
    writeFileSync(join(configDir, "config", "plugins.json"), JSON.stringify([plugin], null, 2), "utf8");

    const { downgrade, updatePluginPublic } = await import("../index.js");

    const result = downgrade({ name: plugin.name, url: plugin.url, branch: plugin.branch }, firstHash);
    expect(result).toBe("");

    const repoHeadAfterDowngrade = git("git rev-parse HEAD", join(reposDir, "demo-plugin"));
    expect(repoHeadAfterDowngrade).toBe(firstHash);

    const pluginsAfterDowngrade = JSON.parse(readFileSync(join(configDir, "config", "plugins.json"), "utf8")) as Plugin[];
    expect(pluginsAfterDowngrade[0].commitHash).toBe(firstHash);

    // a plain "Update now" (no commitHash) must clear the pin and move past it
    await updatePluginPublic(plugin.name, origin, "main");

    const repoHeadAfterUpdate = git("git rev-parse HEAD", join(reposDir, "demo-plugin"));
    expect(repoHeadAfterUpdate).toBe(secondHash);

    const pluginsAfterUpdate = JSON.parse(readFileSync(join(configDir, "config", "plugins.json"), "utf8")) as Plugin[];
    expect(pluginsAfterUpdate[0].commitHash).toBeUndefined();
  }, 20000);

  it("returns a non-empty error string for a plugin missing its url (no git call attempted)", async () => {
    const { downgrade } = await import("../index.js");
    const result = downgrade({ name: "no-url-plugin" }, "deadbeef");
    expect(result).not.toBe("");
  });

  it("treats an opencode hook invocation (missing commitHash) as a no-op", async () => {
    const { downgrade } = await import("../index.js");
    // opencode invokes every export as a hook with a single context object;
    // the 2nd argument (commitHash) is then undefined
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(downgrade({ ping: true } as any, undefined as any)).toBe("");
  });
});
