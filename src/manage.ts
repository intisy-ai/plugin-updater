import fs from "node:fs";
import path from "node:path";
import type {
  ActionResult, HomeLibraries, LibraryManagementCapability, LibraryRemoval, ManagedNpmPlugin, ManagedPlugin,
  PluginChannel, PluginChannelState, PluginDataEntry, PluginManagementCapability, PluginUpdateCache, UpdateTrigger,
} from "@intisy-ai/core";
import { getEarlyLaunchConfigDir, setEarlyLaunchConfigDir } from "./env.js";
import { getPlugins, getPluginsPath, setPluginAutoUpdate, setPluginChannel, setPluginEnabled } from "./config.js";
import { getLocalHead } from "./git.js";
import { checkUpdates } from "./updates.js";
import type { UpdateOutcome } from "./updates.js";
import { readUpdateCache } from "./cache.js";
import { getNpmPlugins, uninstallNpmPlugin } from "./npm.js";
import { pluginData, removeDataPaths } from "./plugin-data.js";
import { missingPluginArtifacts, repairPlugin } from "./repair.js";
import { homeLibraries, removeLibrary } from "./libraries.js";

export interface RegisterOptions {
  branch?: string;
  sync?: boolean;
}

export interface RegisteredEntry {
  name: string;
  url: string;
  branch?: string;
  added: boolean;
  syncEnabled: boolean;
  /** Whether this call wrote the list. False means the entry was already exactly as asked for. */
  changed: boolean;
}

function readEntries(file: string): Array<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\s*\/\/[^\n]*/gm, ""));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeEntries(file: string, entries: Array<Record<string, unknown>>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(entries, null, 2), "utf8");
}

/**
 * Registers a repository in a home's plugin list, and reports what it did.
 *
 * @remarks
 * Prints nothing: a host calling this through a capability must not write to its stdout, and the
 * CLI phrases its own output from the flags returned here.
 */
export function registerPluginEntry(configDir: string, url: string, opts: RegisterOptions = {}): RegisteredEntry {
  const cleanUrl = url.replace(/\.git$/, "");
  const name = cleanUrl.split("/").pop() ?? cleanUrl;
  const file = getPluginsPath(configDir);
  const entries = readEntries(file);
  const existing = entries.find((entry) => entry.name === name);

  if (!existing) {
    const entry: Record<string, unknown> = { name, url: cleanUrl, enabled: true, autoUpdate: true };
    if (opts.branch) entry.branch = opts.branch;
    if (opts.sync) entry.sync = true;
    entries.push(entry);
    writeEntries(file, entries);
    return { name, url: cleanUrl, branch: opts.branch, added: true, syncEnabled: opts.sync === true, changed: true };
  }

  if (opts.sync && existing.sync !== true) {
    existing.sync = true;
    writeEntries(file, entries);
    return { name, url: cleanUrl, branch: opts.branch, added: false, syncEnabled: true, changed: true };
  }
  return { name, url: cleanUrl, branch: opts.branch, added: false, syncEnabled: existing.sync === true, changed: false };
}

export function removePluginEntry(configDir: string, name: string): void {
  const file = getPluginsPath(configDir);
  writeEntries(file, readEntries(file).filter((entry) => entry.name !== name));
}

function failed(error: unknown): ActionResult {
  return { ok: false, message: String((error as { message?: string })?.message ?? error) };
}

/**
 * What this capability needs from the entry module, injected so neither module imports the other.
 *
 * @remarks
 * Every member here is the entry module's WRAPPED form, which adds `afterInstall` app registration
 * to the raw runner in `updates.ts`. Calling the raw one would install a plugin without registering
 * the app it clones, which is the difference a host cannot see and would not think to ask about.
 */
export interface ManagementDeps {
  updatePluginPublic: (name: string, url: string, branch?: string, commitHash?: string) => Promise<void | object>;
  uninstallPlugin: (configDir: string, name: string) => void;
  updateOne: (configDir: string, name: string) => Promise<UpdateOutcome>;
  updateAll: (configDir: string) => Promise<UpdateOutcome>;
  runUpdates: (configDir: string, trigger: UpdateTrigger) => Promise<UpdateOutcome>;
  downgrade: (plugin: { name: string; url?: string; branch?: string }, commitHash: string) => string;
  pluginChannelState: (configDir: string, name: string) => PluginChannelState;
}

function wrote(changed: boolean, id: string, what: string): ActionResult {
  if (changed) return { ok: true, message: `${id} ${what}` };
  return { ok: false, message: `no plugin ${id} in this home` };
}

function ran(outcome: UpdateOutcome): ActionResult {
  if (outcome.failed.length) return { ok: false, message: `failed to update ${outcome.failed.join(", ")}` };
  return { ok: true, message: outcome.updated.length ? `updated ${outcome.updated.join(", ")}` : "everything is current" };
}

function applied(outcome: UpdateOutcome, id: string): ActionResult {
  if (outcome.failed.includes(id)) return { ok: false, message: `${id} failed to update` };
  return { ok: true, message: outcome.updated.includes(id) ? `updated ${id}` : `${id} is already current` };
}

/**
 * Installs, updates and removes the plugins of ONE home.
 *
 * @remarks
 * Every call states the home for its duration and puts back whatever was there, because this
 * repo's path resolution reads the ambient home otherwise and a host may drive several homes from
 * one process. `setEarlyLaunchConfigDir` is the seam `earlyLaunch` already uses for exactly that;
 * the restore is what a capability adds, since it returns to a caller that may target another home
 * next.
 */
export function pluginManagement(home: string, deps: ManagementDeps): PluginManagementCapability {
  async function inHome<T>(work: () => T | Promise<T>): Promise<T> {
    const previous = getEarlyLaunchConfigDir();
    setEarlyLaunchConfigDir(home);
    try {
      return await work();
    } finally {
      setEarlyLaunchConfigDir(previous);
    }
  }

  return {
    async list(): Promise<ManagedPlugin[]> {
      return inHome(() => getPlugins(home).map((plugin) => ({
        id: plugin.name,
        version: getLocalHead(plugin.name) || "",
        enabled: plugin.enabled !== false,
        url: plugin.url,
        // Absence means the plugin never declared one, which is not the same as declaring
        // "inherit": a surface offering to change it has to be able to tell those apart.
        autoUpdate: plugin.autoUpdate === undefined ? undefined : plugin.autoUpdate !== false,
        channel: plugin.channel,
      })));
    },
    async install(url: string): Promise<ActionResult> {
      const entry = registerPluginEntry(home, url);
      try {
        await inHome(() => deps.updatePluginPublic(entry.name, entry.url, entry.branch));
        return { ok: true, message: `installed ${entry.name}` };
      } catch (error) {
        if (entry.added) removePluginEntry(home, entry.name);
        return failed(error);
      }
    },
    async register(url: string): Promise<ManagedPlugin> {
      const entry = registerPluginEntry(home, url);
      return { id: entry.name, url: entry.url, enabled: true, version: "" };
    },
    async update(id: string): Promise<ActionResult> {
      try {
        return applied(await inHome(() => deps.updateOne(home, id)), id);
      } catch (error) {
        return failed(error);
      }
    },
    async updateAll(): Promise<ActionResult> {
      try {
        return ran(await inHome(() => deps.updateAll(home)));
      } catch (error) {
        return failed(error);
      }
    },
    async runUpdates(trigger: UpdateTrigger): Promise<ActionResult> {
      try {
        return ran(await inHome(() => deps.runUpdates(home, trigger)));
      } catch (error) {
        return failed(error);
      }
    },
    async remove(id: string): Promise<ActionResult> {
      try {
        await inHome(() => deps.uninstallPlugin(home, id));
        return { ok: true, message: `removed ${id}` };
      } catch (error) {
        return failed(error);
      }
    },
    async repair(id: string): Promise<ActionResult> {
      try {
        const health = await inHome(() => repairPlugin(home, id));
        if (health.healthy) return { ok: true, message: `repaired ${id}` };
        return { ok: false, message: `${id} is still missing ${health.missing.join(", ")}` };
      } catch (error) {
        return failed(error);
      }
    },
    async downgrade(id: string, version: string): Promise<ActionResult> {
      try {
        const entry = await inHome(() => getPlugins(home).find((plugin) => plugin.name === id));
        if (!entry) return { ok: false, message: `no plugin ${id} in this home` };
        return { ok: true, message: await inHome(() => deps.downgrade(entry, version)) };
      } catch (error) {
        return failed(error);
      }
    },
    async listNpm(): Promise<ManagedNpmPlugin[]> {
      return inHome(() => getNpmPlugins(home).map((plugin) => ({
        name: plugin.name,
        version: plugin.version,
        installed: plugin.installed,
      })));
    },
    async removeNpm(id: string): Promise<ActionResult> {
      try {
        return { ok: true, message: await inHome(() => uninstallNpmPlugin(id, home)) || `removed ${id}` };
      } catch (error) {
        return failed(error);
      }
    },
    async checkUpdates(): Promise<PluginUpdateCache> {
      return inHome(async () => (await checkUpdates(home)).cache);
    },
    async updateCache(): Promise<PluginUpdateCache> {
      return inHome(() => readUpdateCache(home));
    },
    async missingArtifacts(id: string): Promise<string[]> {
      return inHome(() => missingPluginArtifacts(home, id));
    },
    async channelState(id: string): Promise<PluginChannelState> {
      return inHome(() => deps.pluginChannelState(home, id));
    },
    async data(id: string, declared: string[]): Promise<PluginDataEntry[]> {
      return inHome(() => pluginData(home, id, declared));
    },
    async removeData(paths: string[]): Promise<string[]> {
      return inHome(() => removeDataPaths(home, paths));
    },
    async setEnabled(id: string, enabled: boolean): Promise<ActionResult> {
      return wrote(await inHome(() => setPluginEnabled(home, id, enabled)), id, enabled ? "enabled" : "disabled");
    },
    async setAutoUpdate(id: string, autoUpdate: boolean): Promise<ActionResult> {
      return wrote(await inHome(() => setPluginAutoUpdate(home, id, autoUpdate)), id, autoUpdate ? "auto-updates" : "no longer auto-updates");
    },
    async setChannel(id: string, channel: PluginChannel): Promise<ActionResult> {
      return wrote(await inHome(() => setPluginChannel(home, id, channel)), id, `tracks ${channel}`);
    },
  };
}

/**
 * Manages the shared libraries of ONE home.
 *
 * @remarks
 * Minted beside {@link pluginManagement} rather than folded into it: a library is a different noun,
 * it outlives the plugin that first pulled it in, and a host lists it on its own screen.
 */
export function libraryManagement(home: string): LibraryManagementCapability {
  return {
    async libraries(): Promise<HomeLibraries> {
      return homeLibraries(home);
    },
    async remove(specifier: string): Promise<LibraryRemoval> {
      return removeLibrary(home, specifier);
    },
  };
}
