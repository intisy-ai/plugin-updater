// @ts-nocheck
// Cross-app slash-commands for plugin-updater:
//   /plugin-updater-config — plugin-updater's OWN settings (scoped, like every plugin)
//   /config                — the UNIFIED entry: global settings + ANY installed plugin
// plugin-updater is an npm package (not deployed at plugin/<name>.js), so commands shell
// into this same bundle's index.js by absolute path. The /config dispatcher (config-all)
// enumerates plugins.json and resolves each plugin's deployed bundle.
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import fs from "fs";
import { runConfigCli, runAllConfigCli, deployCommands, getAppConfigDir as coreGetAppConfigDir } from "../lib/core.js";
import { getPlugins } from "./config.js";
import { getAppName } from "./env.js";

const PLUGIN = "plugin-updater";
const SELF = join(dirname(fileURLToPath(import.meta.url)), "index.js");

export function deployUpdaterCommands() {
  try {
    deployCommands(PLUGIN, [
      {
        name: "plugin-updater-config",
        description: "View/change plugin-updater configuration",
        argumentHint: "list | get <key> | set <key> <value>",
        shell: `node "${SELF}" config $ARGUMENTS`,
        body: "Above is the plugin-updater config result. Report it; if the user changed a setting, confirm the new value.",
      },
      {
        name: "config",
        description: "View/change ANY plugin's settings and the global settings",
        argumentHint: "[global | <plugin>] [list | get <key> | set <key> <value>]",
        shell: `node "${SELF}" config-all $ARGUMENTS`,
        body: "Above is the unified ecosystem config: the global settings block plus one block per installed plugin. Present it clearly. If the user asked to change a setting, run `/config <target> set <key> <value>` (target is `global` or the plugin name) and confirm the new value.",
      },
    ]);
  } catch {
    /* best-effort */
  }
}

export async function maybeRunCli() {
  const argv = process.argv.slice(2);
  if (argv[0] === "config") {
    runConfigCli(PLUGIN, argv.slice(1));
    return true;
  }
  if (argv[0] === "config-all") {
    // Use core's getAppConfigDir (respects HUB_OPENCODE_DIR / HUB_CLAUDE_DIR env overrides)
    const configDir = coreGetAppConfigDir();
    const names = getPlugins(configDir).map((p) => p.name);
    const resolveBundle = (name) => {
      if (name === PLUGIN) return SELF;
      const p = join(configDir, "plugin", `${name}.js`);
      return fs.existsSync(p) ? p : null;
    };
    runAllConfigCli(argv.slice(1), { plugins: [...names, PLUGIN], resolveBundle });
    return true;
  }
  return false;
}
