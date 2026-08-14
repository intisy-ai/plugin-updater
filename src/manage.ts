import fs from "node:fs";
import path from "node:path";
import type { ActionResult, ManagedPlugin, PluginManagementCapability } from "@intisy-ai/api";
import { getEarlyLaunchConfigDir, setEarlyLaunchConfigDir } from "./env.js";
import { getPlugins, getPluginsPath } from "./config.js";
import { getLocalHead } from "./git.js";
import { updateOne } from "./updates.js";
import { repairPlugin } from "./repair.js";

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

/** What this capability needs from the entry module, injected so neither module imports the other. */
export interface ManagementDeps {
  updatePluginPublic: (name: string, url: string, branch?: string, commitHash?: string) => Promise<void | object>;
  uninstallPlugin: (configDir: string, name: string) => void;
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
    async update(id: string): Promise<ActionResult> {
      try {
        const outcome = await inHome(() => updateOne(home, id));
        if (outcome.failed.includes(id)) return { ok: false, message: `${id} failed to update` };
        return { ok: true, message: outcome.updated.includes(id) ? `updated ${id}` : `${id} is already current` };
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
  };
}
