import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// A repair never touches git, so the deploy step is the only thing it drives. Stubbing it is
// what lets these run without a clone, a network or a build.
const deployed: Array<{ name: string; changed: boolean }> = [];
let onDeploy: (sourceDir: string) => void = () => {};

vi.mock("../deploy.js", async () => {
  const actual = await vi.importActual<typeof import("../deploy.js")>("../deploy.js");
  return {
    ...actual,
    deployToExecutionDir: vi.fn(async (name: string, _exec: string, changed: boolean, _configDir: string) => {
      deployed.push({ name, changed });
      onDeploy(join(reposDir, name));
      return true;
    }),
  };
});

let home: string;
let reposDir: string;

vi.mock("../env.js", async () => {
  const actual = await vi.importActual<typeof import("../env.js")>("../env.js");
  return { ...actual, getReposDir: () => reposDir };
});

const PROVIDER_PKG = {
  main: "dist/index.js",
  claudeHub: { authProviders: [{ name: "claude-code", handler: "dist/handler.js" }] },
};

function seedClone(name: string, files: string[]): string {
  const dir = join(reposDir, name);
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(PROVIDER_PKG));
  for (const file of files) writeFileSync(join(dir, file), "");
  return dir;
}

describe("plugin repair", () => {
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "pu-repair-"));
    reposDir = join(home, "repos");
    mkdirSync(reposDir, { recursive: true });
    mkdirSync(join(home, "plugin"), { recursive: true });
    deployed.length = 0;
    onDeploy = () => {};
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("calls a clone with every declared file healthy", async () => {
    seedClone("claude-code-auth", ["dist/index.js", "dist/handler.js"]);
    writeFileSync(join(home, "plugin", "claude-code-auth.js"), "");
    const { checkPluginHealth } = await import("../repair.js");
    expect(checkPluginHealth(home, "claude-code-auth")).toMatchObject({ healthy: true, missing: [], cloned: true, deployed: true });
  });

  // The exact state that made claude-code unreachable: right commit, main entry present, and
  // the handler its package.json declares never copied.
  it("calls out a clone whose build left a declared file behind", async () => {
    seedClone("claude-code-auth", ["dist/index.js"]);
    const { checkPluginHealth } = await import("../repair.js");
    expect(checkPluginHealth(home, "claude-code-auth")).toMatchObject({ healthy: false, missing: ["dist/handler.js"] });
  });

  it("reports a plugin that was never cloned as neither healthy nor cloned", async () => {
    const { checkPluginHealth } = await import("../repair.js");
    expect(checkPluginHealth(home, "absent")).toMatchObject({ cloned: false, healthy: false, deployed: false });
  });

  it("rebuilds and reports the clone healthy once the missing file lands", async () => {
    const dir = seedClone("claude-code-auth", ["dist/index.js"]);
    onDeploy = () => writeFileSync(join(dir, "dist", "handler.js"), "");
    const { repairPlugin } = await import("../repair.js");
    const after = await repairPlugin(home, "claude-code-auth");
    // changed: true is what forces the rebuild past the fast path.
    expect(deployed).toEqual([{ name: "claude-code-auth", changed: true }]);
    expect(after).toMatchObject({ healthy: true, missing: [] });
  });

  it("still reports what is missing when the rebuild does not fix it", async () => {
    seedClone("claude-code-auth", ["dist/index.js"]);
    const { repairPlugin } = await import("../repair.js");
    const after = await repairPlugin(home, "claude-code-auth");
    expect(after).toMatchObject({ healthy: false, missing: ["dist/handler.js"] });
  });

  it("refuses to repair a plugin that is not installed", async () => {
    const { repairPlugin } = await import("../repair.js");
    await expect(repairPlugin(home, "absent")).rejects.toThrow(/not installed/);
    expect(deployed).toEqual([]);
  });

  it("checks a whole set of plugins in one pass", async () => {
    seedClone("good", ["dist/index.js", "dist/handler.js"]);
    seedClone("bad", ["dist/index.js"]);
    const { checkAllPluginHealth } = await import("../repair.js");
    const health = checkAllPluginHealth(home, ["good", "bad"]);
    expect(health.map((h) => [h.name, h.healthy])).toEqual([["good", true], ["bad", false]]);
  });
});
