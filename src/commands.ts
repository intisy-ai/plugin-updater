// @ts-nocheck
// Cross-app slash-command for plugin-updater: /plugin-updater-config (the loaders
// own /plugins). plugin-updater is an npm package (not deployed at plugin/<name>.js),
// so the command shells into this same bundle's index.js by its absolute path.
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { runConfigCli, deployCommands } from "../lib/core.js";

const PLUGIN = "plugin-updater";
// the deployed entry that carries the maybeRunCli guard (dist/index.js, sibling).
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
    ]);
  } catch {
    /* best-effort */
  }
}

// If invoked as `node dist/index.js config …`, run the config CLI and return true
// so the entry exits before the updater/self-activate sequence.
export async function maybeRunCli() {
  const argv = process.argv.slice(2);
  if (argv[0] === "config") {
    runConfigCli(PLUGIN, argv.slice(1));
    return true;
  }
  return false;
}
