import { getAppConfigDir, getAppName, isOpencodeHookInvocation, setEarlyLaunchConfigDir } from "./env.js";
import { writeLog } from "./log.js";
import { getPlugins, readOpencodeJson } from "./config.js";
import { selfUpdate, updateNpmPlugin } from "./npm.js";
import { updatePlugin } from "./git.js";
import { deployToExecutionDir } from "./deploy.js";
import path from "path";
import type { Plugin } from "./types.js";

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
// the full updater sequence on import would print over their screen
if (process.env.PLUGIN_UPDATER_LIBRARY_MODE !== "1") activate();
