// The policy decides whether a check turns into a pull, and the lock decides whether a
// run happens at all. Real local git origins, isolated temp home, no network.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execSync } from "child_process";
import { getPluginsPath } from "../config.js";
import { getCachePath } from "../cache.js";
import { setEarlyLaunchConfigDir } from "../env.js";
import type { UpdateCache } from "../cache.js";

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
let entries: Record<string, unknown>[] = [];

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "pu-auto-cfg-"));
  originsRoot = mkdtempSync(join(tmpdir(), "pu-auto-origin-"));
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.HUB_CONFIG_DIR = configDir;
  process.env.HUB_OPENCODE_DIR = configDir;
  process.env.HUB_CLAUDE_DIR = join(tmpdir(), `pu-auto-noop-${Date.now()}`);
  process.env.CORE_APP = "opencode";
  process.env.PLUGIN_UPDATER_APP = "opencode";
  process.env.PLUGIN_UPDATER_LIBRARY_MODE = "1";
  mkdirSync(join(configDir, "config"), { recursive: true });
  mkdirSync(join(configDir, "repos"), { recursive: true });
  setEarlyLaunchConfigDir(configDir);
  entries = [];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(configDir, { recursive: true, force: true });
  rmSync(originsRoot, { recursive: true, force: true });
});

// a clone that is exactly one commit behind its origin
function seedBehindClone(name: string, entryOverrides: Record<string, unknown> = {}): { firstHash: string; secondHash: string } {
  const origin = join(originsRoot, "origin-" + name);
  const firstHash = initRepo(origin);
  git(`git clone --branch main "${origin}" "${name}"`, join(configDir, "repos"));
  const secondHash = commitMore(origin, "two");
  entries.push({ name, url: origin, branch: "main", enabled: true, ...entryOverrides });
  writeFileSync(getPluginsPath(configDir), JSON.stringify(entries), "utf8");
  return { firstHash, secondHash };
}

// a clone one commit behind an origin that also carries the channel branch
function seedBehindCloneWithChannel(name: string): { firstHash: string; secondHash: string } {
  const origin = join(originsRoot, "origin-" + name);
  const firstHash = initRepo(origin);
  git("git branch experimental", origin);
  git(`git clone --branch main "${origin}" "${name}"`, join(configDir, "repos"));
  const secondHash = commitMore(origin, "two");
  entries.push({ name, url: origin, branch: "main", enabled: true });
  writeFileSync(getPluginsPath(configDir), JSON.stringify(entries), "utf8");
  return { firstHash, secondHash };
}

function writeConfig(values: Record<string, unknown>): void {
  writeFileSync(join(configDir, "config", "plugin-updater.json"), JSON.stringify({ self_update: false, ...values }), "utf8");
}

function readCache(): UpdateCache {
  return JSON.parse(readFileSync(getCachePath(configDir), "utf8")) as UpdateCache;
}

function head(name: string): string {
  return git("git rev-parse HEAD", join(configDir, "repos", name));
}

describe("runAutoUpdate", () => {
  it("checks but does not pull when the home only checks", async () => {
    const { firstHash } = seedBehindClone("check-only");
    writeConfig({ auto_update_mode: "check" });

    const { runAutoUpdate } = await import("../updates.js");
    const outcome = await runAutoUpdate(configDir, { trigger: "loader" });

    expect(outcome.updated).toEqual([]);
    expect(head("check-only")).toBe(firstHash);
    // the badge data is still refreshed
    expect(readCache().plugins["check-only"].updateAvailable).toBe(true);
  }, 60000);

  it("pulls a plugin that opted in even though the home only checks", async () => {
    const { secondHash } = seedBehindClone("opted-in", { autoUpdate: "on" });
    writeConfig({ auto_update_mode: "check" });

    const { runAutoUpdate } = await import("../updates.js");
    const outcome = await runAutoUpdate(configDir, { trigger: "loader" });

    expect(outcome.updated).toEqual(["opted-in"]);
    expect(head("opted-in")).toBe(secondHash);
    expect(readCache().plugins["opted-in"].updateAvailable).toBe(false);
  }, 60000);

  it("leaves a plugin that opted out alone in a home that updates", async () => {
    const { firstHash } = seedBehindClone("opted-out", { autoUpdate: "off" });
    writeConfig({ auto_update_mode: "update" });

    const { runAutoUpdate } = await import("../updates.js");
    const outcome = await runAutoUpdate(configDir, { trigger: "loader" });

    expect(outcome.updated).toEqual([]);
    expect(outcome.skipped).toEqual(["opted-out"]);
    expect(head("opted-out")).toBe(firstHash);
  }, 60000);

  it("does nothing at all for a trigger the home disabled", async () => {
    const { firstHash } = seedBehindClone("no-trigger");
    writeConfig({ auto_update_mode: "update", auto_update_triggers: { cairn: false } });

    const { runAutoUpdate } = await import("../updates.js");
    const outcome = await runAutoUpdate(configDir, { trigger: "cairn" });

    expect(outcome).toMatchObject({ updated: [], skipped: [], failed: [] });
    expect(head("no-trigger")).toBe(firstHash);
    // not even a check ran, so there is no cache yet
    expect(() => readCache()).toThrow();
  }, 60000);

  it("reports progress at debug for the plugin it actually pulls", async () => {
    seedBehindClone("progress-demo");
    writeConfig({ auto_update_mode: "update" });
    // progress sits at debug, so a home only records it when it asks to see debug
    writeFileSync(join(configDir, "config", "settings.json"), JSON.stringify({ activityMinImpact: "debug" }), "utf8");

    const { runAutoUpdate } = await import("../updates.js");
    await runAutoUpdate(configDir, { trigger: "loader" });

    const { drain } = await import("@intisy-ai/core");
    const events: { topic: string; payload: { details?: { name?: string; phase?: string }; impact?: string } }[] = [];
    drain("auto-progress", (e: typeof events[number]) => events.push(e));
    const progress = events.filter((e) => e.topic === "plugin.progress");
    expect(progress.some((e) => e.payload.details?.name === "progress-demo" && e.payload.details?.phase === "updating")).toBe(true);
    expect(progress.every((e) => e.payload.impact === "debug")).toBe(true);
  }, 60000);

  // The bug this pins: policy used to come from core's loadConfig, which caches per home
  // for the life of the process INCLUDING the absence of a file. A plugin that loads
  // before its home is configured then kept "no config" (which reads as update) forever,
  // so a home set to check would still be pulled. Policy is read from disk per run now.
  it("honours a mode written after something already read this home's config", async () => {
    const { firstHash } = seedBehindClone("late-config");
    // poison the cache exactly as a module-load defineConfig does, before any config exists
    const core = await import("@intisy-ai/core");
    core.loadConfig("plugin-updater", configDir);

    writeConfig({ auto_update_mode: "check" });

    const { runAutoUpdate } = await import("../updates.js");
    const outcome = await runAutoUpdate(configDir, { trigger: "loader" });

    expect(outcome.updated).toEqual([]);
    expect(head("late-config")).toBe(firstHash);
  }, 60000);

  it("updates on an enabled trigger in a home that updates", async () => {
    const { secondHash } = seedBehindClone("plain");
    writeConfig({ auto_update_mode: "update" });

    const { runAutoUpdate } = await import("../updates.js");
    const outcome = await runAutoUpdate(configDir, { trigger: "app" });

    expect(outcome.updated).toEqual(["plain"]);
    expect(head("plain")).toBe(secondHash);
  }, 60000);

  // The pull path re-records localHead/remoteHead after checkUpdates already detected
  // the channel branch; that re-record must forward the detected value, not drop it.
  it("carries a detected channel branch forward across a pull instead of resetting it to null", async () => {
    seedBehindCloneWithChannel("channel-plugin");
    writeConfig({ auto_update_mode: "update" });

    const { runAutoUpdate } = await import("../updates.js");
    const outcome = await runAutoUpdate(configDir, { trigger: "loader" });

    expect(outcome.updated).toEqual(["channel-plugin"]);
    expect(readCache().plugins["channel-plugin"].experimentalAvailable).toBe(true);
  }, 60000);
});

describe("a human asking", () => {
  it("updateOne pulls just that plugin and clears its badge", async () => {
    const { secondHash } = seedBehindClone("one-of-two");
    seedBehindClone("other");
    writeConfig({ auto_update_mode: "off" });

    const { updateOne } = await import("../updates.js");
    const outcome = await updateOne(configDir, "one-of-two");

    expect(outcome.updated).toEqual(["one-of-two"]);
    expect(head("one-of-two")).toBe(secondHash);
    expect(readCache().plugins["one-of-two"].updateAvailable).toBe(false);
    expect(readCache().plugins["other"].updateAvailable).toBe(true);
  }, 60000);

  it("updateOne refuses a name that is not installed", async () => {
    writeConfig({});
    writeFileSync(getPluginsPath(configDir), JSON.stringify([]), "utf8");
    const { updateOne } = await import("../updates.js");
    await expect(updateOne(configDir, "never-installed")).rejects.toThrow("plugin not found");
  }, 60000);

  it("updateAll pulls every behind plugin even with the home switched off", async () => {
    const first = seedBehindClone("all-one");
    const second = seedBehindClone("all-two", { autoUpdate: "off" });
    writeConfig({ auto_update_mode: "off" });

    const { updateAll } = await import("../updates.js");
    const outcome = await updateAll(configDir);

    expect(outcome.updated.sort()).toEqual(["all-one", "all-two"]);
    expect(head("all-one")).toBe(first.secondHash);
    expect(head("all-two")).toBe(second.secondHash);
  }, 60000);
});

describe("the update lock", () => {
  it("skips the run entirely while another process holds it", async () => {
    const { firstHash } = seedBehindClone("locked-out");
    writeConfig({ auto_update_mode: "update" });
    writeFileSync(join(configDir, "repos", ".update.lock"), JSON.stringify({ pid: process.ppid, at: Date.now() }), "utf8");

    const { runAutoUpdate } = await import("../updates.js");
    const outcome = await runAutoUpdate(configDir, { trigger: "loader" });

    expect(outcome).toMatchObject({ updated: [], skipped: [], failed: [] });
    expect(head("locked-out")).toBe(firstHash);
  }, 60000);

  it("takes over a lock left behind by a process that died", async () => {
    const { secondHash } = seedBehindClone("after-crash");
    writeConfig({ auto_update_mode: "update" });
    writeFileSync(join(configDir, "repos", ".update.lock"), JSON.stringify({ pid: 999999999, at: Date.now() }), "utf8");

    const { runAutoUpdate } = await import("../updates.js");
    const outcome = await runAutoUpdate(configDir, { trigger: "loader" });

    expect(outcome.updated).toEqual(["after-crash"]);
    expect(head("after-crash")).toBe(secondHash);
  }, 60000);

  it("takes over a lock older than any real run", async () => {
    const { secondHash } = seedBehindClone("stale-lock");
    writeConfig({ auto_update_mode: "update" });
    writeFileSync(join(configDir, "repos", ".update.lock"), JSON.stringify({ pid: process.ppid, at: Date.now() - 3_600_000 }), "utf8");

    const { runAutoUpdate } = await import("../updates.js");
    const outcome = await runAutoUpdate(configDir, { trigger: "loader" });

    expect(outcome.updated).toEqual(["stale-lock"]);
    expect(head("stale-lock")).toBe(secondHash);
  }, 60000);

  it("releases the lock when the run finishes", async () => {
    seedBehindClone("released");
    writeConfig({ auto_update_mode: "update" });

    const { runAutoUpdate } = await import("../updates.js");
    await runAutoUpdate(configDir, { trigger: "loader" });

    expect(() => readFileSync(join(configDir, "repos", ".update.lock"), "utf8")).toThrow();
  }, 60000);
});
