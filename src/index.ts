import { getAppConfigDir, getAppName, getReposDir, isOpencodeHookInvocation, setEarlyLaunchConfigDir, getPluginDir } from "./env.js";
import { writeLog } from "./log.js";
import { getPlugins, getPluginsPath, readOpencodeJson, setPluginCommitHash } from "./config.js";
import { selfUpdate, updateNpmPlugin, resolveNpmPluginVersion } from "./npm.js";
import { updatePlugin, getLocalHead } from "./git.js";
import { deployToExecutionDir } from "./deploy.js";
import { syncAllAcrossApps } from "./syncbridge.js";
import { checkUpdates, runAutoUpdate, updateOne as updateOneInHome, updateAll as updateAllInHome } from "./updates.js";
import { resolveMode, type Trigger } from "./policy.js";
// Importing this registers the config defaults and the capability schema, which must
// happen before the CLI guard below so `config schema` answers.
import { updaterSchema } from "./schema.js";
// @ts-ignore — generated bundle, no .d.ts
import { maybeRunCli, deployUpdaterCommands } from "./commands.js";
// @ts-ignore — generated bundle, no .d.ts
import { loadConfig, defineReadme, maybeRunReadmeCli, registerApp, withCause, setActivityContext, getActivityContext, resetActivityContext } from "@intisy-ai/core";
import type { AppDescriptor } from "@intisy-ai/core";
import path from "path";
import fs from "fs";
import type { Plugin } from "./types.js";
import {
  emitPluginInstalled,
  emitPluginUpdated,
  emitPluginUpdateAvailable,
  emitPluginUpdateFailed,
  emitPluginActivated,
  emitPluginUninstalled,
  emitPluginDowngraded,
  emitPluginProgress,
  type ActivityTrigger,
} from "./pluginActivity.js";

// This bundle's core instance is only ever used by this plugin, so naming the entry
// once here is accurate for every event it emits, including the ones outside a run.
setActivityContext({ entry: "updater" });

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
    for (const dir of fs.readdirSync(getReposDir(configDir))) {
      if (!keep.has(dir)) {
        // Said before the removal, not only after: a clone carries its node_modules, so this
        // is the slow part of an uninstall and the only one worth watching.
        writeLog(`Removing repos/${dir}`);
        try { fs.rmSync(path.join(getReposDir(configDir), dir), { recursive: true, force: true }); writeLog(`Pruned orphaned repos/${dir}`); } catch { /* ignore */ }
      }
    }
  } catch { /* no repos dir */ }
  try {
    for (const file of fs.readdirSync(getPluginDir(configDir))) {
      if (!file.endsWith(".js")) continue;
      if (!keep.has(file.slice(0, -3))) {
        try { fs.unlinkSync(path.join(getPluginDir(configDir), file)); writeLog(`Pruned orphaned plugin/${file}`); } catch { /* ignore */ }
      }
    }
  } catch { /* no plugin dir */ }
}

// re-exported public API (consumers import these from "plugin-updater")
export { getNpmPlugins, installNpmPlugin, uninstallNpmPlugin, updateNpmPlugin } from "./npm.js";
export { getPlugins, getPluginsPath } from "./config.js";

// cairn.json is arbitrary on-disk data, so the fields registerApp depends on are
// checked here rather than asserted: a malformed block registers nothing instead of
// entering the registry half-formed.
function isAppDescriptor(value: unknown): value is AppDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<AppDescriptor>;
  return (
    typeof candidate.id === "string" &&
    candidate.id.length > 0 &&
    typeof candidate.label === "string" &&
    Array.isArray(candidate.home?.candidates) &&
    candidate.home.candidates.length > 0
  );
}

// A loader's clone carries its app descriptor in cairn.json (`app` block). Register
// it into the shared app registry so a dashboard discovers apps from the loaders
// installed here, with no hardcoded app list. Best-effort: a plugin without an
// `app` block (any non-loader) registers nothing.
export function registerAppFromClone(name: string, reposDir: string = getReposDir()): void {
  try {
    const manifestPath = path.join(reposDir, name, "cairn.json");
    if (!fs.existsSync(manifestPath)) return;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { app?: unknown };
    if (isAppDescriptor(manifest.app)) registerApp(manifest.app);
  } catch {
    // no manifest or malformed on disk: register nothing
  }
}

// Called whenever a plugin finishes installing or updating: announce it (as
// "installed" on a plugin's first clone, "updated" when a previous version
// existed) and keep the app registry in sync with the loaders on disk.
function onInstalled(name: string, version: string | null, previousVersion: string | null, trigger: ActivityTrigger): void {
  if (previousVersion !== null) emitPluginUpdated(name, previousVersion, version, trigger);
  else emitPluginInstalled(name, version, trigger);
  registerAppFromClone(name);
}

export async function updatePluginPublic(
  pluginName: string,
  gitUrl: string,
  branch?: string,
  commitHash?: string
): Promise<void | object> {
  if (isOpencodeHookInvocation(pluginName)) return {};
  writeLog(`Public API update call for ${pluginName}`);
  const configDir = getAppConfigDir(getAppName());
  const repoDir = path.join(getReposDir(configDir), pluginName);
  const previousVersion = fs.existsSync(repoDir) ? getLocalHead(pluginName) : null;
  // interval 0: an explicit update request must never fast-path-skip
  const result = updatePlugin(pluginName, gitUrl, branch, commitHash ?? null, 0);
  if (!result.success) {
    const err = new Error(`could not set up ${pluginName} - see the updater log`);
    emitPluginUpdateFailed(pluginName, err);
    throw err;
  }
  // persist the pin so the NEXT earlyLaunch (a normal pull) doesn't undo this downgrade;
  // a plain "Update now" (no commitHash) clears any earlier pin so it can move past it
  if (commitHash) setPluginCommitHash(configDir, pluginName, commitHash);
  else setPluginCommitHash(configDir, pluginName, null);
  await deployToExecutionDir(pluginName, getPluginDir(configDir), result.changed, configDir);
  if (result.changed) onInstalled(pluginName, getLocalHead(pluginName), previousVersion, "manual");
  else registerAppFromClone(pluginName);
}

// core-loader's downgrade TUI action calls this SYNCHRONOUSLY and expects a string
// ("" or "Success" = ok, anything else = an error message shown to the user), so it
// cannot be async. Checks out the pinned commit and persists it (setPluginCommitHash)
// so the pin survives the next earlyLaunch; deploy happens on the next restart.
export function downgrade(
  plugin: { name: string; url?: string; branch?: string },
  commitHash: string
): string {
  // opencode invokes every plugin export as a hook with a single context object;
  // our real calls always pass a commitHash string as the 2nd argument
  if (typeof commitHash !== "string" || !commitHash) return "";
  if (!plugin || !plugin.name || !plugin.url) return "invalid plugin";
  writeLog(`Downgrade requested for ${plugin.name} -> ${commitHash}`);
  try {
    const configDir = getAppConfigDir(getAppName());
    // interval 0: a downgrade must never fast-path-skip
    const result = updatePlugin(plugin.name, plugin.url, plugin.branch, commitHash, 0);
    if (!result.success) return `could not check out ${commitHash} for ${plugin.name} - see the updater log`;
    setPluginCommitHash(configDir, plugin.name, commitHash);
    try { emitPluginDowngraded(plugin.name, commitHash, configDir); } catch { /* never fail a completed downgrade */ }
    return "";
  } catch (e: unknown) {
    const msg = (e as { message?: string }).message ?? String(e);
    writeLog(`Failed to downgrade ${plugin.name}: ${msg}`, true);
    return msg;
  }
}

export function uninstallPlugin(configDir: string, name: string): void {
  const file = getPluginsPath(configDir);
  const entries = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as Plugin[]) : [];
  const entry = entries.find((e) => e.name === name);
  if (!entry) throw new Error(`plugin not found: ${name}`);
  const remaining = entries.filter((e) => e.name !== name);
  // read the version before pruning removes the clone it comes from
  const removedVersion = getLocalHead(name) || "";
  fs.writeFileSync(file, JSON.stringify(remaining, null, 2), "utf8");
  writeLog(`Uninstalled plugin ${name}`);
  try {
    emitPluginUninstalled(name, {
      kind: "git",
      version: removedVersion,
      url: entry.url || "",
      message: `Uninstalled ${name}${removedVersion ? " (" + removedVersion.slice(0, 8) + ")" : ""}`,
    }, configDir);
  } catch { /* never fail a completed uninstall */ }
  pruneOrphans(configDir, remaining);
}

export async function earlyLaunch(configDir: string, plugins: Plugin[], opts: { trigger?: Trigger } = {}): Promise<void | object> {
  if (isOpencodeHookInvocation(configDir)) return {};
  // A caller can run this for several homes in one process (a dashboard iterating
  // over the installed apps), so the home is stated for the duration of the run and
  // restored afterwards: a sticky home would send a later run's records here.
  const outerContext = getActivityContext();
  setActivityContext({ home: configDir });
  try {
    return await withCause({ kind: "startup", surface: "launch" }, () => earlyLaunchInScope(configDir, plugins, opts.trigger ?? "app"));
  } finally {
    resetActivityContext();
    setActivityContext(outerContext);
  }
}

async function earlyLaunchInScope(configDir: string, plugins: Plugin[], trigger: Trigger): Promise<void> {
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

  // reconcile cross-app state (accounts, settings, configs, plugin list) BEFORE
  // building, then re-read the list so a freshly-synced-in plugin is cloned/built
  // this pass. Falls back to plugins-only sync on an older sync-bridge.
  await syncAllAcrossApps(configDir);
  plugins = getPlugins(configDir);

  // One activation per plugin this home actually loads, so a plugin that emits
  // nothing of its own is still visible from the moment the app starts. Absence of
  // the enabled key means enabled, matching the loader TUI and the loop below.
  for (const plugin of plugins) {
    if (plugin.enabled === false) continue;
    try { emitPluginActivated(plugin.name, { kind: "git" }); } catch { /* never block launch */ }
  }

  const updateOnLaunch = cfg.update_on_launch !== false;

  // npm plugins listed in opencode.json: their install path is npm's, not git's, so it
  // stays here. Everything git-shaped, plus the cache both surfaces read, is runAutoUpdate's.
  const { plugins: npmNamesRaw } = readOpencodeJson(configDir);
  const npmNames = npmNamesRaw.map((raw) => raw.replace(/@[^@/]+$/, "") || raw);
  // snapshot BEFORE selfUpdate runs (this list includes "plugin-updater" itself when
  // registered in opencode.json) so the before/after diff below detects a self-update
  const npmVersionsBefore = new Map<string, string | null>();
  for (const name of npmNames) npmVersionsBefore.set(name, resolveNpmPluginVersion(name, configDir) || null);

  const installing = resolveMode(cfg) === "update";
  if (installing && cfg.self_update !== false) selfUpdate(configDir);

  if (installing) {
    for (const name of npmNames) {
      if (name === "plugin-updater") continue; // already self-updated above
      writeLog(`npm earlyLaunch update for ${name}`);
      try {
        updateNpmPlugin(name, configDir);
      } catch (e: unknown) {
        writeLog(`Failed npm update for ${name}: ${(e as { message: string }).message}`, true);
        emitPluginUpdateFailed(name, e);
      }
    }
  }

  for (const name of npmNames) {
    // plugin-updater is the thing doing the reporting, not one of the plugins it loads
    if (name !== "plugin-updater") {
      try { emitPluginActivated(name, { kind: "npm" }); } catch { /* never block launch */ }
    }
    const installedVersion = resolveNpmPluginVersion(name, configDir) || null;
    const before = npmVersionsBefore.get(name) ?? null;
    if (before !== null && installedVersion !== null && before !== installedVersion) {
      onInstalled(name, installedVersion, before, "launch");
    }
  }

  if (!plugins || !Array.isArray(plugins)) {
    writeLog("No git plugins provided to earlyLaunch", true);
    await runAutoUpdate(configDir, { trigger, plugins: [], afterInstall: registerAppFromClone });
    return;
  }

  await runAutoUpdate(configDir, { trigger, plugins, afterInstall: registerAppFromClone });

  if (plugins.length > 0) pruneOrphans(configDir, plugins);
}

// The update surface, re-exported so a consumer reaches it the same way it reaches
// updatePluginPublic: the registry side-effect is wired here, once.
export { checkUpdates };
export { checkPluginHealth, checkAllPluginHealth, missingPluginArtifacts, repairPlugin, type PluginHealth } from "./repair.js";
export { homeLibraries, sharedLibraries, pluginDependencies, removeLibrary, orphanedLibraries, type HomeLibraries, type InstalledLibrary, type PluginDependencies } from "./libraries.js";
export { updaterSchema };

export function updateOne(configDir: string, name: string) {
  return updateOneInHome(configDir, name, { afterInstall: registerAppFromClone });
}

export function updateAll(configDir: string) {
  return updateAllInHome(configDir, { afterInstall: registerAppFromClone });
}

export function runUpdates(configDir: string, trigger: Trigger) {
  return runAutoUpdate(configDir, { trigger, afterInstall: registerAppFromClone });
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
