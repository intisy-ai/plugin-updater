import { getAppConfigDir, getAppName, isOpencodeHookInvocation, setEarlyLaunchConfigDir } from "./env.js";
import { writeLog } from "./log.js";
import { getPlugins, readOpencodeJson, setPluginCommitHash } from "./config.js";
import { selfUpdate, updateNpmPlugin, resolveNpmPluginVersion, precomputeLatestNpmVersions } from "./npm.js";
import { updatePlugin, precomputeRemoteHashes, getLocalHead } from "./git.js";
import { deployToExecutionDir } from "./deploy.js";
import { syncPluginsAcrossApps } from "./syncbridge.js";
import { readUpdateCache, writeUpdateCache, gitUpdateAvailable, npmUpdateAvailable, recordCacheEntry, type UpdateCache } from "./cache.js";
// @ts-ignore — generated bundle, no .d.ts
import { maybeRunCli, deployUpdaterCommands } from "./commands.js";
// @ts-ignore — generated bundle, no .d.ts
import { defineConfig, loadConfig, defineReadme, maybeRunReadmeCli } from "../lib/core.js";
import path from "path";
import fs from "fs";
import type { Plugin } from "./types.js";

// `node dist/index.js config …` (from the /plugin-updater-config command) runs the
// config CLI and exits, before the self-activation/updater sequence below.
// Register config defaults BEFORE the CLI guard so `config schema` sees them (no write).
defineConfig("plugin-updater", {
  logging: true,
  default_update_interval_hours: 1,
  git_timeout_seconds: 120,
  npm_timeout_seconds: 300,
  build_timeout_seconds: 300,
  daemon_health_timeout_ms: 1500,
  self_update: true,
  update_on_launch: true,
});

defineReadme({
  description: "Plugin lifecycle manager for OpenCode and Claude Code launchers. Handles install, update, rebuild, downgrade, and uninstall operations for all plugins.",
  architecture: `flowchart TD
    %% Triggers
    subgraph Execution_Triggers [Execution Triggers]
        CLI_BOOT[CLI Startup (claude/oc)]
        TUI_MENU[Launcher TUI Actions]

        CLI_BOOT -->|Auto-runs hook on start| UPDATER_CORE
        TUI_MENU -->|Manual rebuild/downgrade/uninstall| UPDATER_CORE
    end

    %% Core Logic
    subgraph Plugin_Updater [Updater Core Logic]
        UPDATER_CORE[Updater Engine]
        API_LAYER[global.OpenCodeAPI Interop]
        GIT_MGR[Git Operations Manager]
        DEPLOYER[Plugin Deployer]

        UPDATER_CORE <-->|Requests repo paths| API_LAYER
        UPDATER_CORE -->|Trigger sync| GIT_MGR
        UPDATER_CORE -->|Trigger deploy| DEPLOYER
    end

    %% External & Storage
    subgraph Storage_and_Network [Storage & External]
        GH_REPOS[GitHub (intisy-ai/plugin-*)]
        LOCAL_WORKSPACE[(.config/github/repos/intisy-ai/)]
        CC_PLUGINS[(.claude/plugin/)]
        OC_PLUGINS[(.config/opencode/plugin/)]

        GIT_MGR <-->|git clone/pull| GH_REPOS
        GIT_MGR -->|Updates source| LOCAL_WORKSPACE
        DEPLOYER -->|Copies compiled output| CC_PLUGINS
        DEPLOYER -->|Copies compiled output| OC_PLUGINS
    end`,
  structure: {
    src: ["TypeScript source (`index` engine + `git`, `npm`, `deploy`, `config`, `log`, `env`, `syncbridge`, `cli`, `commands`)."],
    dist: ["`dist/index.js` — plugin entry + the `node … config` CLI; `dist/cli.js` — the `plugin-updater` bin."],
  },
  commands: [
    {
      name: "plugin-updater-config",
      description: "View/change plugin-updater configuration",
      argumentHint: "list | get <key> | set <key> <value>",
    },
    {
      name: "config",
      description: "View/change ANY plugin's settings and the global settings",
      argumentHint: "[global | <plugin>] [list | get <key> | set <key> <value>]",
    },
  ],
  dependencies: ["core", "sync-bridge"],
  extraSections: [
    {
      id: "adding-plugins",
      title: "Adding plugins",
      after: "installation",
      body: `plugin-updater is the one plugin added directly to OpenCode's \`opencode.jsonc\` (every other plugin goes through \`plugins.json\`); the loaders also resolve and run it on startup. To register a plugin from the CLI:
\`\`\`bash
plugin-updater add https://github.com/intisy-ai/<plugin>      # register a git plugin
plugin-updater add https://github.com/intisy-ai/<plugin> --sync  # …and mirror it to the other app
\`\`\``,
    },
    {
      id: "sync",
      title: "Cross-app plugin sync (`sync: true`)",
      after: "adding-plugins",
      body: `A \`plugins.json\` entry flagged \`sync: true\` is mirrored into the **other** app's \`plugins.json\`, so a plugin enabled in OpenCode is also installed in Claude Code (and vice versa). At the start of \`earlyLaunch\`, plugin-updater loads [sync-bridge](https://github.com/intisy-ai/sync-bridge)'s library bundle (\`dist/lib.js\`) and calls \`syncPlugins()\`, then re-reads the list so a freshly-synced-in plugin is cloned and built in the **same** launch. It is additive (never removes) and a no-op when sync-bridge isn't installed.

\`\`\`jsonc
{ "name": "antigravity-auth", "url": "https://github.com/intisy-ai/antigravity-auth", "enabled": true, "autoUpdate": false, "sync": true }
\`\`\`

Set it from the CLI with \`--sync\`:
\`\`\`bash
plugin-updater add https://github.com/intisy-ai/antigravity-auth --sync
\`\`\``,
    },
    {
      id: "api",
      title: "API",
      after: "sync",
      body: `| Method | Description |
|---|---|
| \`rebuild(pluginItem)\` | Pull latest and redeploy |
| \`downgrade(pluginItem, commitHash)\` | Checkout specific commit |
| \`disable(pluginItem)\` | Cleanup on disable |
| \`uninstall(pluginItem)\` | Remove repo and deployed files |
| \`registerTests(testApi)\` | Register sync verification tests |`,
    },
  ],
});

if (maybeRunReadmeCli("plugin-updater")) process.exit(0);

if (await maybeRunCli()) {
  process.exit(0);
}

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
  // persist the pin so the NEXT earlyLaunch (a normal pull) doesn't undo this downgrade
  if (commitHash) setPluginCommitHash(configDir, pluginName, commitHash);
  await deployToExecutionDir(pluginName, path.join(configDir, "plugin"), result.changed, configDir);
}

export async function earlyLaunch(configDir: string, plugins: Plugin[]): Promise<void | object> {
  if (isOpencodeHookInvocation(configDir)) return {};
  setEarlyLaunchConfigDir(configDir);
  writeLog("Starting earlyLaunch updater sequence");

  // read config once for the whole earlyLaunch sequence
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cfg = loadConfig("plugin-updater") as Record<string, any>;
  const defaultIntervalHours = typeof cfg.default_update_interval_hours === "number"
    ? cfg.default_update_interval_hours
    : 1;

  // keep the cross-app /plugin-updater-config command deployed (idempotent) + the
  // config file materialized (so it's discoverable in the home / agentbox data folder)
  try { deployUpdaterCommands(); } catch { /* best-effort */ }

  // pull in any `sync: true` plugins from the other app BEFORE building, then
  // re-read the list so a freshly-synced-in plugin is cloned/built this pass.
  await syncPluginsAcrossApps(configDir);
  plugins = getPlugins(configDir);

  const updateOnLaunch = cfg.update_on_launch !== false;

  // the update-status cache (<configDir>/cache/plugin-updates.json) is the single
  // source of truth the loader TUI reads to render update state synchronously; it is
  // assembled across this whole function and written once at the end (best-effort).
  const checkedAt = new Date().toISOString();
  const previousCache = readUpdateCache(configDir);
  const cache: UpdateCache = { checkedAt, plugins: {} };

  // update_on_launch:false suppresses remote-update work (selfUpdate, npm
  // updates, and git pull/rebuild for already-cloned plugins). Plugins that
  // have never been cloned still get a full clone+build so a freshly-added
  // plugin is usable immediately even in manual-update mode.
  if (updateOnLaunch && cfg.self_update !== false) selfUpdate(configDir);

  // npm plugins listed in opencode.json. The cache is recorded for every npm plugin
  // regardless of update_on_launch (cheap, best-effort registry lookups) so the
  // loader can show npm update availability even in manual-update mode.
  const { plugins: npmNamesRaw } = readOpencodeJson(configDir);
  const npmNames = npmNamesRaw.map((raw) => raw.replace(/@[^@/]+$/, "") || raw);
  const npmVersionsBefore = new Map<string, string | null>();
  for (const name of npmNames) npmVersionsBefore.set(name, resolveNpmPluginVersion(name, configDir) || null);

  if (updateOnLaunch) {
    for (const name of npmNames) {
      if (name === "plugin-updater") continue; // already self-updated above
      writeLog(`npm earlyLaunch update for ${name}`);
      try {
        updateNpmPlugin(name, configDir);
      } catch (e: unknown) {
        writeLog(`Failed npm update for ${name}: ${(e as { message: string }).message}`, true);
      }
    }
  }

  const npmLatestVersions = await precomputeLatestNpmVersions(npmNames);
  for (const name of npmNames) {
    const installedVersion = resolveNpmPluginVersion(name, configDir) || null;
    const latestVersion = npmLatestVersions.get(name) ?? null;
    const before = npmVersionsBefore.get(name) ?? null;
    const changed = before !== null && installedVersion !== null && before !== installedVersion;
    recordCacheEntry(cache, previousCache, name, {
      kind: "npm",
      installedVersion,
      localHead: null,
      remoteHead: null,
      latestVersion,
      updateAvailable: npmUpdateAvailable(installedVersion, latestVersion),
    }, changed, checkedAt);
  }

  if (!plugins || !Array.isArray(plugins)) {
    writeLog("No git plugins provided to earlyLaunch", true);
    writeUpdateCache(configDir, cache);
    return;
  }

  // One parallel pass of ls-remote for all plugins up front, so the per-plugin
  // change check below is a local comparison instead of N serial network round-trips.
  // Not gated on autoUpdate: an autoUpdate:false plugin still needs its remote state
  // checked for the cache, it just skips the pull/build below.
  const remoteHashes = updateOnLaunch ? await precomputeRemoteHashes(plugins) : new Map<string, string>();

  for (const plugin of plugins) {
    // absence of the enabled key means enabled, matching the loader TUI
    if (plugin.enabled === false) { writeLog(`Skipping disabled plugin ${plugin.name}`); continue; }
    if (!plugin.url) { writeLog(`Skipping ${plugin.name}: no url in plugins.json`, true); continue; }

    const repoDir = path.join(configDir, "repos", plugin.name);
    const alreadyCloned = fs.existsSync(repoDir);

    // when update_on_launch is false, skip update+deploy for already-cloned
    // plugins; only do a full clone+build for plugins not yet on disk
    if (!updateOnLaunch && alreadyCloned) {
      writeLog(`Skipping update for ${plugin.name} (update_on_launch disabled, already cloned)`);
      const localHead = getLocalHead(plugin.name);
      recordCacheEntry(cache, previousCache, plugin.name, {
        kind: "git", installedVersion: null, localHead, remoteHead: null,
        latestVersion: null, updateAvailable: false,
      }, false, checkedAt);
      continue;
    }

    // autoUpdate:false skips only the pull/build, once a clone already exists — a
    // never-cloned plugin still needs its first install regardless of the flag. The
    // remote is still checked so the cache's updateAvailable reflects reality.
    if (plugin.autoUpdate === false && updateOnLaunch && alreadyCloned) {
      writeLog(`Skipping auto-update for ${plugin.name} (autoUpdate off) - checking remote only`);
      const localHead = getLocalHead(plugin.name);
      const remoteHead = remoteHashes.get(plugin.name) ?? null;
      recordCacheEntry(cache, previousCache, plugin.name, {
        kind: "git", installedVersion: null, localHead, remoteHead,
        latestVersion: null, updateAvailable: gitUpdateAvailable(localHead, remoteHead),
      }, false, checkedAt);
      continue;
    }

    writeLog(`Processing earlyLaunch for ${plugin.name}`);
    try {
      const updateResult = updatePlugin(plugin.name, plugin.url, plugin.branch, plugin.commitHash ?? null, plugin.updateInterval ?? defaultIntervalHours, remoteHashes.get(plugin.name));
      const localHead = getLocalHead(plugin.name);
      const remoteHead = remoteHashes.get(plugin.name) ?? null;
      recordCacheEntry(cache, previousCache, plugin.name, {
        kind: "git", installedVersion: null, localHead, remoteHead,
        latestVersion: null, updateAvailable: gitUpdateAvailable(localHead, remoteHead),
      }, updateResult.changed, checkedAt);
      if (!updateResult.success) {
        writeLog(`Skipping deploy for ${plugin.name}: update failed`, true);
        continue;
      }
      await deployToExecutionDir(plugin.name, path.join(configDir, "plugin"), updateResult.changed, configDir);
    } catch (e: unknown) {
      writeLog(`Failed to process ${plugin.name}: ${(e as { message: string }).message}`, true);
    }
  }

  writeUpdateCache(configDir, cache);

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
