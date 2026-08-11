import { afterEach, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectExperimentalBranches } from "../git.js";

let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function git(command: string, cwd: string): string {
  return execSync(command, { cwd, windowsHide: true }).toString().trim();
}

function makeOrigin(name: string, withChannel: boolean): string {
  const dir = join(root as string, name);
  mkdirSync(dir, { recursive: true });
  git("git init -b main", dir);
  git('git config user.email "test@test.com"', dir);
  git('git config user.name "test"', dir);
  writeFileSync(join(dir, "file.txt"), "one", "utf8");
  git("git add .", dir);
  git('git -c commit.gpgsign=false commit -m "first"', dir);
  if (withChannel) git("git branch experimental", dir);
  return dir;
}

describe("detectExperimentalBranches", () => {
  it("answers true only for a remote that carries the branch", async () => {
    root = mkdtempSync(join(tmpdir(), "pu-detect-"));
    const withChannel = makeOrigin("has", true);
    const withoutChannel = makeOrigin("lacks", false);

    const detected = await detectExperimentalBranches([
      { name: "has", url: withChannel },
      { name: "lacks", url: withoutChannel },
    ], "experimental");

    expect(detected.get("has")).toBe(true);
    expect(detected.get("lacks")).toBe(false);
  }, 60000);

  // An unreachable remote must leave no entry at all, so the caller records unknown
  // rather than a confident "no such branch".
  it("leaves an unreachable remote unanswered", async () => {
    root = mkdtempSync(join(tmpdir(), "pu-detect-"));
    const detected = await detectExperimentalBranches(
      [{ name: "gone", url: join(root, "does-not-exist") }],
      "experimental",
      5000,
    );

    expect(detected.has("gone")).toBe(false);
  }, 60000);

  it("skips a disabled plugin and one with no url", async () => {
    root = mkdtempSync(join(tmpdir(), "pu-detect-"));
    const withChannel = makeOrigin("has", true);
    const detected = await detectExperimentalBranches([
      { name: "has", url: withChannel, enabled: false },
      { name: "urlless" },
    ], "experimental");

    expect(detected.size).toBe(0);
  }, 60000);
});
