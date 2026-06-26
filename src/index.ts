import { getAppConfigDir, getAppName, isOpencodeHookInvocation, setEarlyLaunchConfigDir } from "./env.js";
import { writeLog } from "./log.js";
import { getPlugins, readOpencodeJson } from "./config.js";
import { selfUpdate, updateNpmPlugin } from "./npm.js";
import { updatePlugin } from "./git.js";
import { deployToExecutionDir } from "./deploy.js";
import { syncPluginsAcrossApps } from "./syncbridge.js";
import path from "path";
import fs from "fs";
import type { Plugin } from "./types.js";

// remove repos/ clones and deployed plugin/ files for plugins no longer in
// plugins.json, so a removed/renamed plugin stops showing up
function pruneOrphans(configDir: string, plugins: Plugin[]): void {
  const keep = new Set(plugins.map((p) => p.name));
  try {
    for (const dir of fs.readdirSync(path.join(configDir, "repos"))) {
      if (!keep.has(dir)) {
        try { fs.rmSync(path.join(configDir, "repos", dir), { recursive: true, force: true }); writeLog(`Pruned orphaned repos/${dir}`); } catch { /* ignore */ }
      }
    }
  } catch { /* no repos dir */ }
  try {
    for (const file of fs.readdirSync(path.join(configDir, "plugin"))) {
      if (!file.endsWith(".js")) continue;
      if (!keep.has(file.slice(0, -3))) {
        try { fs.unlinkSync(path.join(configDir, "plugin", file)); writeLog(`Pruned orphaned plugin/${file}`); } catch { /* ignore */ }
      }
    }
  } catch { /* no plugin dir */ }
}

// re-exported public API (consumers import these from "plugin-updater")
export { getNpmPlugins, installNpmPlugin, uninstallNpmPlugin, updateNpmPlugin } from "./npm.js";
export { getPlugins, getPluginsPath } from "./config.js";

export async function updatePluginPublic(
  pluginName: string,
  gitUrl: string,
  branch?: string,
  commitHash?: string
): Promise<void | object> {
  if (isOpencodeHookInvocation(pluginName)) return {};
  writeLog(`Public API update call for ${pluginName}`);
  const configDir = getAppConfigDir(getAppName());
  // interval 0: an explicit update request must never fast-path-skip
  const result = updatePlugin(pluginName, gitUrl, branch, commitHash ?? null, 0);
  if (!result.success) throw new Error(`could not set up ${pluginName} - see the updater log`);
  await deployToExecutionDir(pluginName, path.join(configDir, "plugin"), result.changed, configDir);
}

export async function earlyLaunch(configDir: string, plugins: Plugin[]): Promise<void | object> {
  if (isOpencodeHookInvocation(configDir)) return {};
  setEarlyLaunchConfigDir(configDir);
  writeLog("Starting earlyLaunch updater sequence");

  // pull in any `sync: true` plugins from the other app BEFORE building, then
  // re-read the list so a freshly-synced-in plugin is cloned/built this pass.
  await syncPluginsAcrossApps(configDir);
  plugins = getPlugins(configDir);

  selfUpdate(configDir);

  // npm plugins listed in opencode.json
  const { plugins: npmNames } = readOpencodeJson(configDir);
  for (const raw of npmNames) {
    const name = raw.replace(/@[^@/]+$/, "") || raw;
    if (name === "plugin-updater") continue; // already self-updated above
    writeLog(`npm earlyLaunch update for ${name}`);
    try {
      updateNpmPlugin(name, configDir);
    } catch (e: unknown) {
      writeLog(`Failed npm update for ${name}: ${(e as { message: string }).message}`, true);
    }
  }

  if (!plugins || !Array.isArray(plugins)) {
    writeLog("No git plugins provided to earlyLaunch", true);
    return;
  }

  for (const plugin of plugins) {
    // absence of the enabled key means enabled, matching the loader TUI
    if (plugin.enabled === false) { writeLog(`Skipping disabled plugin ${plugin.name}`); continue; }
    if (plugin.autoUpdate === false) { writeLog(`Skipping auto-update for ${plugin.name} (autoUpdate off)`); continue; }
    if (!plugin.url) { writeLog(`Skipping ${plugin.name}: no url in plugins.json`, true); continue; }

    writeLog(`Processing earlyLaunch for ${plugin.name}`);
    try {
      const updateResult = updatePlugin(plugin.name, plugin.url, plugin.branch, null, plugin.updateInterval ?? 1);
      if (!updateResult.success) {
        writeLog(`Skipping deploy for ${plugin.name}: update failed`, true);
        continue;
      }
      await deployToExecutionDir(plugin.name, path.join(configDir, "plugin"), updateResult.changed, configDir);
    } catch (e: unknown) {
      writeLog(`Failed to process ${plugin.name}: ${(e as { message: string }).message}`, true);
    }
  }

  if (plugins.length > 0) pruneOrphans(configDir, plugins);
}

export async function activate(opencodeHookInput?: unknown): Promise<void | object> {
  // module load below calls activate() with no argument; opencode passes a
  // context object when re-invoking the export — return an inert plugin instance
  if (opencodeHookInput !== undefined) return {};
  const appName = getAppName();
  const configDir = getAppConfigDir(appName);
  writeLog(`Plugin updater activating for ${appName}`);

  const gitPlugins = getPlugins(configDir);
  writeLog(`Found ${gitPlugins.length} git plugins in plugins.json`);
  await earlyLaunch(configDir, gitPlugins);
}

// consumers like the loader TUI import this module for its API only — running
// the full updater sequence on import would print over their screen.
// The ACTIVATION guard makes self-activation idempotent PER PROCESS: opencode may
// load plugin-updater as more than one module instance (its npm-plugin copy plus a
// loader's separately-resolved copy), and each would otherwise run earlyLaunch. The
// first sets the flag; later instances (and the loaders' runEarlyLaunchHooks) skip.
if (process.env.PLUGIN_UPDATER_LIBRARY_MODE !== "1" && process.env.PLUGIN_UPDATER_ACTIVATION !== "1") {
  process.env.PLUGIN_UPDATER_ACTIVATION = "1";
  activate();
}
