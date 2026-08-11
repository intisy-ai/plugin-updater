// checkUpdates records what is available and never touches a clone. Real local git
// origins, isolated temp home, no network.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execSync } from "child_process";
// @ts-ignore: generated bundle, no .d.ts
import { readActivity } from "@intisy-ai/core";
import { getPluginsPath } from "../config.js";
import { getCachePath, writeUpdateCache } from "../cache.js";
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

let configDir: string;
let originsRoot: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "pu-check-cfg-"));
  originsRoot = mkdtempSync(join(tmpdir(), "pu-check-origin-"));
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.HUB_CONFIG_DIR = configDir;
  process.env.HUB_OPENCODE_DIR = configDir;
  process.env.HUB_CLAUDE_DIR = join(tmpdir(), `pu-check-noop-${Date.now()}`);
  process.env.CORE_APP = "opencode";
  process.env.PLUGIN_UPDATER_APP = "opencode";
  process.env.PLUGIN_UPDATER_LIBRARY_MODE = "1";
  mkdirSync(join(configDir, "config"), { recursive: true });
  mkdirSync(join(configDir, "repos"), { recursive: true });
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

function seedBehindClone(name: string): { origin: string; firstHash: string; secondHash: string } {
  const origin = join(originsRoot, "origin-" + name);
  const firstHash = initRepo(origin);
  git(`git clone --branch main "${origin}" "${name}"`, join(configDir, "repos"));
  const secondHash = commitMore(origin, "two");
  writeFileSync(getPluginsPath(configDir), JSON.stringify([
    { name, url: origin, branch: "main", enabled: true },
  ]), "utf8");
  return { origin, firstHash, secondHash };
}

describe("checkUpdates", () => {
  it("records what is available without touching the clone", async () => {
    const { firstHash, secondHash } = seedBehindClone("check-demo");

    const { checkUpdates } = await import("../updates.js");
    const result = await checkUpdates(configDir);

    expect(result.available).toEqual(["check-demo"]);
    const entry = result.cache.plugins["check-demo"];
    expect(entry.localHead).toBe(firstHash);
    expect(entry.remoteHead).toBe(secondHash);
    expect(entry.updateAvailable).toBe(true);
    // a check never pulls
    expect(git("git rev-parse HEAD", join(configDir, "repos", "check-demo"))).toBe(firstHash);
    // and it lands in the cache the TUI reads
    const onDisk = JSON.parse(readFileSync(getCachePath(configDir), "utf8"));
    expect(onDisk.plugins["check-demo"].updateAvailable).toBe(true);
  }, 60000);

  it("reports nothing available for an up-to-date clone, and still stamps a fresh check", async () => {
    const origin = join(originsRoot, "origin-current");
    initRepo(origin);
    git(`git clone --branch main "${origin}" "current-demo"`, join(configDir, "repos"));
    writeFileSync(getPluginsPath(configDir), JSON.stringify([
      { name: "current-demo", url: origin, branch: "main", enabled: true },
    ]), "utf8");

    const { checkUpdates } = await import("../updates.js");
    const result = await checkUpdates(configDir);

    expect(result.available).toEqual([]);
    expect(new Date(result.checkedAt).getTime()).toBeGreaterThan(0);
    expect(result.cache.plugins["current-demo"].updateAvailable).toBe(false);
  }, 60000);

  it("leaves a disabled plugin out of the check entirely", async () => {
    const origin = join(originsRoot, "origin-off");
    initRepo(origin);
    git(`git clone --branch main "${origin}" "off-demo"`, join(configDir, "repos"));
    commitMore(origin, "two");
    writeFileSync(getPluginsPath(configDir), JSON.stringify([
      { name: "off-demo", url: origin, branch: "main", enabled: false },
    ]), "utf8");

    const { checkUpdates } = await import("../updates.js");
    const result = await checkUpdates(configDir);

    expect(result.available).toEqual([]);
    expect(result.cache.plugins["off-demo"]).toBeUndefined();
  }, 60000);

  it("records a check as an activity event only when something is available", async () => {
    seedBehindClone("emit-demo");

    const { checkUpdates } = await import("../updates.js");
    await checkUpdates(configDir);

    const { records } = readActivity([configDir], { topics: ["plugin.installed"] });
    const rec = records.find((r: { action: string }) => r.action === "updates_available");
    expect(rec).toBeDefined();
    expect(rec.details.count).toBe(1);
    expect(rec.details.names).toEqual(["emit-demo"]);
    expect(rec.origin.home).toBe(configDir);
  }, 60000);

  it("says nothing on the activity bus when everything is current", async () => {
    const origin = join(originsRoot, "origin-quiet");
    initRepo(origin);
    git(`git clone --branch main "${origin}" "quiet-demo"`, join(configDir, "repos"));
    writeFileSync(getPluginsPath(configDir), JSON.stringify([
      { name: "quiet-demo", url: origin, branch: "main", enabled: true },
    ]), "utf8");

    const { checkUpdates } = await import("../updates.js");
    await checkUpdates(configDir);

    const { records } = readActivity([configDir], { topics: ["plugin.installed"] });
    expect(records.find((r: { action: string }) => r.action === "updates_available")).toBeUndefined();
  }, 60000);

  it("records experimentalAvailable true for a remote that carries the branch and false for one that does not", async () => {
    const withOrigin = join(originsRoot, "origin-with-channel");
    initRepo(withOrigin);
    git("git branch experimental", withOrigin);
    git(`git clone --branch main "${withOrigin}" "with-channel"`, join(configDir, "repos"));

    const withoutOrigin = join(originsRoot, "origin-without-channel");
    initRepo(withoutOrigin);
    git(`git clone --branch main "${withoutOrigin}" "without-channel"`, join(configDir, "repos"));

    writeFileSync(getPluginsPath(configDir), JSON.stringify([
      { name: "with-channel", url: withOrigin, branch: "main", enabled: true },
      { name: "without-channel", url: withoutOrigin, branch: "main", enabled: true },
    ]), "utf8");

    const { checkUpdates } = await import("../updates.js");
    const result = await checkUpdates(configDir);

    expect(result.cache.plugins["with-channel"].experimentalAvailable).toBe(true);
    expect(result.cache.plugins["without-channel"].experimentalAvailable).toBe(false);
    const onDisk = JSON.parse(readFileSync(getCachePath(configDir), "utf8"));
    expect(onDisk.plugins["with-channel"].experimentalAvailable).toBe(true);
    expect(onDisk.plugins["without-channel"].experimentalAvailable).toBe(false);
  }, 60000);

  it("records a definite false from detection instead of falling back to a stale previous-cache true", async () => {
    const origin = join(originsRoot, "origin-regress");
    initRepo(origin);
    git(`git clone --branch main "${origin}" "regress-demo"`, join(configDir, "repos"));
    writeFileSync(getPluginsPath(configDir), JSON.stringify([
      { name: "regress-demo", url: origin, branch: "main", enabled: true },
    ]), "utf8");
    // A previous run once saw the branch; the remote no longer carries it, and this
    // run's definite `false` must win over that stale `true`.
    writeUpdateCache(configDir, {
      checkedAt: new Date().toISOString(),
      plugins: {
        "regress-demo": {
          kind: "git", installedVersion: null, localHead: "deadbeef", remoteHead: "deadbeef",
          latestVersion: null, updateAvailable: false, experimentalAvailable: true, updatedAt: null,
        },
      },
    });

    const { checkUpdates } = await import("../updates.js");
    const result = await checkUpdates(configDir);

    expect(result.cache.plugins["regress-demo"].experimentalAvailable).toBe(false);
  }, 60000);
});
