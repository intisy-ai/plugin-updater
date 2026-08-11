import { afterEach, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function git(command: string, cwd: string): string {
  return execSync(command, { cwd, windowsHide: true }).toString().trim();
}

function commit(dir: string, content: string): string {
  writeFileSync(join(dir, "file.txt"), content, "utf8");
  git("git add .", dir);
  git('git -c commit.gpgsign=false commit -m "change"', dir);
  return git("git rev-parse HEAD", dir);
}

describe("updatePlugin on a channel branch", () => {
  // A force-pushed branch is not a fast-forward, so a --ff-only pull leaves the clone
  // behind while reporting nothing.
  it("follows a force-pushed branch instead of stranding the clone", async () => {
    root = mkdtempSync(join(tmpdir(), "pu-branch-"));
    const origin = join(root, "origin");
    const home = join(root, "home");
    mkdirSync(origin, { recursive: true });
    mkdirSync(join(home, "repos"), { recursive: true });
    process.env.HUB_CONFIG_DIR = home;

    git("git init -b main", origin);
    git('git config user.email "test@test.com"', origin);
    git('git config user.name "test"', origin);
    commit(origin, "one");
    git("git checkout -b experimental", origin);
    commit(origin, "experimental one");

    const { updatePlugin } = await import("../git.js");
    expect(updatePlugin("demo", origin, "experimental", null, 0).success).toBe(true);

    git("git reset --hard HEAD~1", origin);
    const rewritten = commit(origin, "experimental rewritten");

    expect(updatePlugin("demo", origin, "experimental", null, 0).success).toBe(true);
    expect(git("git rev-parse HEAD", join(home, "repos", "demo"))).toBe(rewritten);
  }, 120000);
});
