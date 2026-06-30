import { it, expect } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { deployUpdaterCommands } from "../commands.js";

it("deploys a unified /config command alongside /plugin-updater-config", () => {
  const dir = mkdtempSync(join(tmpdir(), "pu-cmd-"));
  process.env.HUB_OPENCODE_DIR = dir;
  process.env.CORE_APP = "opencode";
  deployUpdaterCommands();
  const cfg = join(dir, "command", "config.md");
  expect(existsSync(cfg)).toBe(true);
  expect(readFileSync(cfg, "utf8")).toContain("config-all $ARGUMENTS");
  delete process.env.HUB_OPENCODE_DIR; delete process.env.CORE_APP;
});
