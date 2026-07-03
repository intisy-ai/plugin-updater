import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { execSync } from "child_process";
import { getAppName, getReposDir } from "./env.js";
import { writeLog } from "./log.js";
import { buildInTempDir } from "./git.js";
import { startDeclaredDaemon } from "./daemon.js";

async function callPluginCleanup(pluginExecutionFile: string, configDir: string): Promise<void> {
  if (!fs.existsSync(pluginExecutionFile)) return;
  try {
    const mod = await import(pluginExecutionFile);
    if (typeof mod.cleanup === "function") {
      writeLog(`Calling cleanup() on ${pluginExecutionFile}`);
      await mod.cleanup(configDir);
      writeLog(`cleanup() complete for ${pluginExecutionFile}`);
    }
  } catch (e: unknown) {
    writeLog(`cleanup() call failed for ${pluginExecutionFile}: ${(e as { message: string }).message}`, true);
  }
}

// under claude, deployed plugins declare env/daemon in package.json#claudeHub;
// merge the env into settings.json so providers work without a login
function applyClaudeManifest(sourceDir: string, configDir: string, pluginName: string): void {
  if (getAppName() !== "claude") return;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(sourceDir, "package.json"), "utf8")) as {
      claudeHub?: { env?: Record<string, string> };
    };
    const manifest = pkg.claudeHub;
    if (!manifest?.env || typeof manifest.env !== "object") return;
    const settingsPath = path.join(configDir, "settings.json");
    let settings: Record<string, unknown> = {};
    try { settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>; } catch { /* fresh file */ }
    const env = (settings.env ?? {}) as Record<string, string>;
    for (const [key, value] of Object.entries(manifest.env)) {
      env[key] = String(value);
      writeLog(`settings.json env ${key} set by ${pluginName}`);
    }
    settings.env = env;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");
  } catch (e: unknown) {
    writeLog(`claudeHub manifest handling failed for ${pluginName}: ${(e as { message: string }).message}`, true);
  }
}

export async function deployToExecutionDir(pluginName: string, executionPath: string, changed: boolean, configDir: string): Promise<boolean> {
  const sourceDir = path.join(getReposDir(), pluginName);
  if (!fs.existsSync(sourceDir)) return false;

  const packageJsonPath = path.join(sourceDir, "package.json");
  let entryFile = "index.js";
  const pluginExecutionFile = path.join(executionPath, `${pluginName}.js`);
  const deployedExists = fs.existsSync(pluginExecutionFile);
  // Fast path: nothing changed and the deployed file is already in place. Skips the
  // build/install AND (below) the copy + plugin re-import + re-activate, which
  // otherwise cost ~1s+ per plugin on EVERY launch and blocked startup.
  const nothingToDeploy = !changed && deployedExists;

  if (nothingToDeploy) {
    writeLog(`Skipping install/build for ${pluginName} (no changes and deployed file exists)`);
  } else if (fs.existsSync(packageJsonPath)) {
    try {
      buildInTempDir(pluginName, sourceDir);
      const runtimeDeps = (JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { dependencies?: Record<string, string> }).dependencies;
      if (runtimeDeps && Object.keys(runtimeDeps).length > 0) {
        writeLog(`Installing runtime dependencies for ${pluginName}`);
        execSync("npm install --omit=dev", { cwd: sourceDir, stdio: "pipe" });
        writeLog(`Finished runtime dependencies for ${pluginName}`);
      }
    } catch (error: unknown) {
      const err = error as { message: string; stderr?: Buffer; stdout?: Buffer };
      const stderr = err.stderr ? err.stderr.toString().trim() : "";
      const stdout = err.stdout ? err.stdout.toString().trim() : "";
      writeLog(`Build/Install failed for ${pluginName}: ${err.message}`, true);
      if (stderr) writeLog(`npm stderr: ${stderr}`, true);
      if (stdout) writeLog(`npm stdout: ${stdout}`, true);
    }
  }

  if (fs.existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { main?: string };
      if (pkg.main) entryFile = pkg.main;
    } catch { /* ignore */ }
  }

  const distPath = path.join(sourceDir, "dist");
  let deploySource = path.join(sourceDir, entryFile);
  if (fs.existsSync(path.join(distPath, entryFile))) {
    deploySource = path.join(distPath, entryFile);
  } else if (fs.existsSync(path.join(distPath, "index.js"))) {
    deploySource = path.join(distPath, "index.js");
  }

  // the build may have produced nothing (e.g. it failed, or the repo was deployed
  // bundle-only with its source stripped) — skip gracefully rather than throwing
  // ENOENT on the copy. Any already-deployed plugin/<name>.js stays in place.
  // Only touch the deployed file when something actually changed — the cleanup
  // imports the old module and the copy rewrites it, both pointless when unchanged.
  if (!nothingToDeploy) {
    if (!fs.existsSync(deploySource)) {
      writeLog(`Skipping deploy for ${pluginName}: built file not found at ${deploySource}`, true);
      return deployedExists;
    }
    if (!fs.existsSync(executionPath)) fs.mkdirSync(executionPath, { recursive: true });
    await callPluginCleanup(pluginExecutionFile, configDir);
    try {
      writeLog(`Running copy for ${pluginName}`);
      fs.copyFileSync(deploySource, pluginExecutionFile);
      writeLog(`Finished copy for ${pluginName}`);
    } catch (e: unknown) {
      writeLog(`Copy failed for ${pluginName}: ${(e as { message: string }).message}`, true);
    }
  }

  applyClaudeManifest(sourceDir, configDir, pluginName);
  await startDeclaredDaemon(sourceDir, configDir, pluginName);

  // Claude Code never imports deployed plugin files, so under claude the
  // updater is the runtime and invokes the plugin's activate() itself.
  // A loader ALSO needs activate() after any deploy — even under opencode —
  // because a TUI-driven self-update runs inside the `bun tui.js` process (not
  // opencode), so nothing else refreshes the oc/cc wrapper. Without this, the
  // wrapper keeps pointing at the stale/rebuilt TUI path and the command breaks
  // until the next app restart. activate() is idempotent (installs the wrapper,
  // earlyLaunch is guarded by PLUGIN_UPDATER_ACTIVATION), so the extra call under
  // opencode's normal launch is harmless.
  const isLoader = pluginName === "opencode-loader" || pluginName === "claude-code-loader";
  // Claude: the updater IS the runtime, so it must import + activate() every launch.
  // OpenCode imports deployed plugins itself, so only loaders need activate() (to
  // refresh their oc/cc wrapper) and only when something deployed — the unchanged
  // fast path skips this entirely, which is the bulk of the startup speedup.
  const needActivate = getAppName() === "claude" ? true : (isLoader && !nothingToDeploy);
  if (needActivate) {
    try {
      // callPluginCleanup() above imported the OLD file at this path, poisoning
      // Node's ESM cache for it; the copy has since overwritten it with fresh code.
      // A cache-busting query forces a fresh module load so activate() runs the new
      // code (otherwise it regenerates the wrapper from the stale, cached module).
      const freshUrl = `${pathToFileURL(pluginExecutionFile).href}?v=${Date.now()}`;
      const deployed = await import(freshUrl);
      if (typeof deployed.activate === "function") {
        writeLog(`Activating ${pluginName}`);
        // tells the plugin the updater is the caller, so it must not start
        // another earlyLaunch and recurse back into the updater
        process.env.PLUGIN_UPDATER_ACTIVATION = "1";
        try {
          await deployed.activate();
        } finally {
          delete process.env.PLUGIN_UPDATER_ACTIVATION;
        }
        writeLog(`Activated ${pluginName}`);
      }
    } catch (e: unknown) {
      writeLog(`Activation failed for ${pluginName}: ${(e as { message: string }).message}`, true);
    }
  }
  return true;
}
