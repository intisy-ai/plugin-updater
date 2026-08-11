import fs from "node:fs";
import path from "node:path";
import { getPaths } from "./env.js";
import { writeLog } from "./log.js";

// What a plugin leaves behind in a home besides its clone and its deployed bundle. Almost
// all of it is found rather than declared: core names a plugin's config, logs and cache
// entries after the plugin itself, so the convention IS the answer for anything built on
// core. A plugin only declares a path when it writes somewhere its name does not appear.

export interface PluginDataEntry {
  // Relative to the home, which is what a confirmation should show: an absolute path is
  // noise, and the home is the thing being cleaned.
  path: string;
  bytes: number;
  // Set where the plugin asked for this path rather than core's naming finding it.
  declared?: boolean;
}

function sizeOf(target: string): number {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch {
    return 0;
  }
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const entry of fs.readdirSync(target)) total += sizeOf(path.join(target, entry));
  return total;
}

function entriesIn(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

// A file belongs to the plugin when it IS the plugin's name or is prefixed by it followed by
// a separator: "sync-bridge.json" and "sync-bridge-12-00-00.log" are its own, while
// "sync-bridge-extras.json" (a different plugin) is not, because "-extras" is not a suffix
// this convention produces on a bare name.
function ownedBy(entry: string, plugin: string): boolean {
  if (entry === plugin) return true;
  if (!entry.startsWith(plugin)) return false;
  const rest = entry.slice(plugin.length);
  return rest.startsWith(".") || /^-\d/.test(rest);
}

function relative(home: string, target: string): string {
  return path.relative(home, target).split(path.sep).join("/");
}

// Only what core provably names after the plugin: its config (both the config/ file and the
// home-root fallback) and its log files. The cache is deliberately not swept, because nothing
// there carries an owner's name (`plugin-updates.json`, `device-id`); a plugin with cache of
// its own declares it. The account store and the shared settings sit under names of their
// own, so a name-scoped sweep never reaches them.
function conventionalPaths(home: string, plugin: string): string[] {
  const paths = getPaths(home);
  const found: string[] = [];

  for (const dir of [paths.config, home]) {
    for (const entry of entriesIn(dir)) {
      if (ownedBy(entry, plugin)) found.push(path.join(dir, entry));
    }
  }

  // Logs are filed under a directory per day, so the sweep is one level deeper.
  const logsDir = path.join(home, "logs");
  for (const day of entriesIn(logsDir)) {
    for (const entry of entriesIn(path.join(logsDir, day))) {
      if (ownedBy(entry, plugin)) found.push(path.join(logsDir, day, entry));
    }
  }

  return found;
}

// A declared path is resolved against the home and kept only if it stays inside it: a plugin
// naming something outside its home is naming data it does not own.
function declaredPaths(home: string, declared: string[]): string[] {
  const root = path.resolve(home);
  const found: string[] = [];
  for (const entry of declared) {
    const target = path.resolve(home, entry);
    if (target !== root && !target.startsWith(root + path.sep)) continue;
    if (fs.existsSync(target)) found.push(target);
  }
  return found;
}

// Everything this plugin owns in this home, each with its size so a confirmation can say
// what it is about to delete. Nothing is removed here.
export function pluginData(configDir: string, plugin: string, declared: string[] = []): PluginDataEntry[] {
  const conventional = new Set(conventionalPaths(configDir, plugin));
  const entries: PluginDataEntry[] = [...conventional].map((target) => ({ path: relative(configDir, target), bytes: sizeOf(target) }));
  for (const target of declaredPaths(configDir, declared)) {
    if (conventional.has(target)) continue;
    entries.push({ path: relative(configDir, target), bytes: sizeOf(target), declared: true });
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

// Deletes exactly what pluginData reported, re-resolved and re-checked here: the caller
// passes back relative paths, and a path that has since moved outside the home is skipped
// rather than trusted.
export function removePluginData(configDir: string, plugin: string, declared: string[] = []): string[] {
  const removed: string[] = [];
  const root = path.resolve(configDir);
  for (const entry of pluginData(configDir, plugin, declared)) {
    const target = path.resolve(configDir, entry.path);
    if (!target.startsWith(root + path.sep)) continue;
    try {
      fs.rmSync(target, { recursive: true, force: true });
      removed.push(entry.path);
    } catch (error) {
      writeLog(`Could not remove ${entry.path} for ${plugin}: ${String(error)}`, true);
    }
  }
  if (removed.length > 0) writeLog(`Removed ${removed.length} data path(s) for ${plugin}`);
  return removed;
}
