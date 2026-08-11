import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plugin } from "../types.js";

const ENV_KEYS = ["HUB_CONFIG_DIR", "HUB_CLAUDE_DIR", "HUB_OPENCODE_DIR", "CORE_APP", "PLUGIN_UPDATER_APP", "PLUGIN_UPDATER_LIBRARY_MODE"];
const saved: Record<string, string | undefined> = {};
let root: string | undefined;

function git(command: string, cwd: string): string {
  return execSync(command, { cwd, windowsHide: true }).toString().trim();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pu-switch-"));
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  process.env.HUB_CONFIG_DIR = root;
  process.env.HUB_OPENCODE_DIR = root;
  process.env.CORE_APP = "opencode";
  process.env.PLUGIN_UPDATER_APP = "opencode";
  process.env.PLUGIN_UPDATER_LIBRARY_MODE = "1";
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(join(root, "config", "plugin-updater.json"), JSON.stringify({ self_update: false }), "utf8");
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe("updating a plugin on the experimental channel", () => {
  it("checks out the channel branch and clears a pin left from the other branch", async () => {
    const home = root as string;
    const origin = join(home, "origin");
    mkdirSync(origin, { recursive: true });
    mkdirSync(join(home, "repos"), { recursive: true });
    git("git init -b main", origin);
    git('git config user.email "test@test.com"', origin);
    git('git config user.name "test"', origin);
    writeFileSync(join(origin, "file.txt"), "main", "utf8");
    git("git add .", origin);
    git('git -c commit.gpgsign=false commit -m "main"', origin);
    const mainHead = git("git rev-parse HEAD", origin);
    git("git checkout -b experimental", origin);
    writeFileSync(join(origin, "file.txt"), "experimental", "utf8");
    git("git add .", origin);
    git('git -c commit.gpgsign=false commit -m "experimental"', origin);
    const channelHead = git("git rev-parse HEAD", origin);
    git("git checkout main", origin);

    const entry: Plugin = { name: "demo", url: origin, enabled: true, channel: "experimental", commitHash: mainHead };
    writeFileSync(join(home, "config", "plugins.json"), JSON.stringify([entry], null, 2), "utf8");

    const { updatePluginPublic } = await import("../index.js");
    await updatePluginPublic("demo", origin);

    expect(git("git rev-parse HEAD", join(home, "repos", "demo"))).toBe(channelHead);
    const after = JSON.parse(readFileSync(join(home, "config", "plugins.json"), "utf8")) as Plugin[];
    expect(after[0].commitHash).toBeUndefined();
  }, 180000);
});
