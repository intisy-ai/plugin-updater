// tsc emits dist/ as separate modules, which is what library consumers import
// (config.js, cache.js, npm.js and friends all share one module state that way).
// Deployment copies a SINGLE file into an app's plugin dir, so that file has to
// carry everything with it: this bundle is the artifact package.json#pluginEntry
// names. sync-bridge stays out of it, resolved from its own clone at runtime.
import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/plugin.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  logLevel: "info",
  // Materialised once per home by this package itself, rather than carried by every plugin that
  // uses it. api is external for the same reason and for a sharper one: its generated engine is
  // 782 KB, nine times this whole bundle, so a private copy would dominate the deployed artifact.
  external: ["@intisy-ai/basekit", "@intisy-ai/basekit/*", "@intisy-ai/api", "@intisy-ai/api/engine", "@intisy-ai/api/host"],
});

console.log("Bundled plugin-updater -> dist/plugin.js (deployed artifact)");
