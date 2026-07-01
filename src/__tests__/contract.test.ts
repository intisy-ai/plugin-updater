// Universal plugin contract via core's shared test-kit. plugin-updater is an npm
// package (not deployed at plugin/<name>.js), so commands deploy via the exported
// deployUpdaterCommands; the loaders own /plugins, so there are no extra actions.
import { runPluginContract } from "../../core/src/testing.js";

runPluginContract({
  name: "plugin-updater",
  entry: "dist/index.js",
  configName: "plugin-updater",
  app: "both",
  commands: ["plugin-updater-config", "config"],
  deploy: { module: "dist/commands.js", fn: "deployUpdaterCommands", arg: "none" },
  readme: true,
});
