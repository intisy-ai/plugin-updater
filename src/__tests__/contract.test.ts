// Universal plugin contract via core's shared test-kit. This plugin contributes no slash-command:
// it declares its settings in plugin.json, and whichever loader serves an app is what offers a way
// to change them.
import { runPluginContract } from "@intisy-ai/core/testing";

runPluginContract({
  name: "plugin-updater",
  entry: "dist/index.js",
  configName: "plugin-updater",
  app: "both",
  readme: true,
});
