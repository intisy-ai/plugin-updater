import { it, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { deployUpdaterCommands } from "../commands.js";
import { withIsolatedHomes } from "../../core/src/testing.js";

it("deploys a unified /config command alongside /plugin-updater-config", () => {
  // Isolate BOTH app homes and seed the app registry: deployCommands fans out to
  // every registered app, so without this it would write into the developer's real
  // ~/.claude/commands (or find no apps at all under the data-driven registry).
  const homes = withIsolatedHomes();
  try {
    deployUpdaterCommands();
    const cfg = join(homes.opencode, "command", "config.md");
    expect(existsSync(cfg)).toBe(true);
    expect(readFileSync(cfg, "utf8")).toContain("config-all $ARGUMENTS");
  } finally {
    homes.cleanup();
  }
});
