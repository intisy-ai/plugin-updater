import fs from "fs";
import path from "path";
import { isOpencodeHookInvocation } from "./env.js";
import { writeLog } from "./log.js";
import type { Plugin } from "./types.js";
// @ts-ignore — generated bundle, no .d.ts
import { getApps } from "@intisy-ai/core";

// Which registered app a config dir belongs to, matched by the app id appearing as a
// path segment (e.g. ".claude" -> "claude", ".config/opencode" -> "opencode"). Returns
// null when no registered app matches (nothing registered yet, or an unrecognized dir).
function appIdForConfigDir(configDir: string): string | null {
  const segments = configDir.replace(/\\/g, "/").toLowerCase().split("/").map((s) => s.replace(/^\./, ""));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hit = (getApps() as Array<{ id: string }>).find((a) => segments.includes(a.id.toLowerCase()));
  return hit ? hit.id : null;
}

// The OTHER apps' loader plugin names, so a config dir never shows/manages a foreign
// app's loader (e.g. a mixed-container init without --app). Data-driven via the shared
// app registry once apps are registered (see registerAppFromClone).
function foreignLoaderNames(configDir: string): string[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const apps = getApps() as Array<{ id: string; loader?: { id: string } }>;
  if (apps.length === 0) {
    // Bootstrap fallback: nothing is registered yet (no loader has ever installed on
    // this machine), so fall back to the two known built-in loaders directly.
    const isClaude = configDir.replace(/\\/g, "/").includes("/.claude");
    return [isClaude ? "opencode-loader" : "claude-code-loader"];
  }
  const currentApp = appIdForConfigDir(configDir);
  return apps.filter((a) => a.loader && a.id !== currentApp).map((a) => a.loader!.id);
}

// opencode reads either opencode.json or opencode.jsonc; resolve the one that
// actually exists (prefer .json) so npm-plugin detection and edits hit the real file.
export function opencodeConfigPath(configDir: string): string {
  const json = path.join(configDir, "opencode.json");
  const jsonc = path.join(configDir, "opencode.jsonc");
  if (fs.existsSync(json)) return json;
  if (fs.existsSync(jsonc)) return jsonc;
  return json;
}

export function readOpencodeJson(configDir: string): { plugins: string[]; raw: Record<string, unknown> } {
  const ocPath = opencodeConfigPath(configDir);
  if (!fs.existsSync(ocPath)) return { plugins: [], raw: {} };
  try {
    const stripped = fs.readFileSync(ocPath, "utf8").replace(/^\s*\/\/[^\n]*/gm, "");
    const parsed = JSON.parse(stripped) as Record<string, unknown>;
    const plugins = (parsed.plugin || []) as string[];
    return { plugins: plugins.filter((p) => typeof p === "string"), raw: parsed };
  } catch { return { plugins: [], raw: {} }; }
}

export function writeOpencodeJson(configDir: string, data: Record<string, unknown>): void {
  fs.writeFileSync(opencodeConfigPath(configDir), JSON.stringify(data, null, 2), "utf8");
}

export function getPluginsPath(configDir: string): string {
  if (isOpencodeHookInvocation(configDir)) return "";
  const preferred = path.join(configDir, "config", "plugins.json");
  const fallback = path.join(configDir, "plugins.json");
  if (fs.existsSync(preferred)) return preferred;
  if (fs.existsSync(fallback)) return fallback;
  return preferred;
}

// single source of truth for the git-plugin list; consumers (loaders, TUI)
// must read through this rather than touching plugins.json directly
export function getPlugins(configDir: string): Plugin[] {
  if (isOpencodeHookInvocation(configDir)) return [];
  const file = getPluginsPath(configDir);
  try {
    if (fs.existsSync(file)) {
      const entries = JSON.parse(fs.readFileSync(file, "utf-8")) as Plugin[];
      if (!Array.isArray(entries)) return [];
      const foreign = foreignLoaderNames(configDir);
      return entries.filter((e) => e && !foreign.includes(e.name));
    }
  } catch (e: unknown) {
    writeLog(`Failed to parse ${file}: ${(e as { message: string }).message}`, true);
  }
  return [];
}

// Adds a plugin to plugins.json, or refreshes the url of an existing entry
// (preserving its enabled/autoUpdate/commitHash). The single writer consumers
// use to register a freshly cloned plugin, so the format lives in one place.
export function registerPlugin(configDir: string, name: string, url: string, autoUpdate = true): void {
  const file = getPluginsPath(configDir);
  if (!file) return;
  const entries: Plugin[] = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as Plugin[]) : [];
  const entry = entries.find((e) => e && e.name === name);
  if (entry) entry.url = url;
  else entries.push({ name, url, enabled: true, autoUpdate });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(entries, null, 2), "utf8");
  writeLog(`Registered plugin ${name}`);
}

// Flips a single field on a plugins.json entry. Returns false when the file or
// the entry is absent so a caller can surface a not-found error.
function setPluginField(configDir: string, name: string, mutate: (entry: Plugin) => void): boolean {
  const file = getPluginsPath(configDir);
  if (!file || !fs.existsSync(file)) return false;
  const entries = JSON.parse(fs.readFileSync(file, "utf-8")) as Plugin[];
  if (!Array.isArray(entries)) return false;
  const entry = entries.find((e) => e && e.name === name);
  if (!entry) return false;
  mutate(entry);
  fs.writeFileSync(file, JSON.stringify(entries, null, 2), "utf8");
  return true;
}

export function setPluginEnabled(configDir: string, name: string, enabled: boolean): boolean {
  return setPluginField(configDir, name, (entry) => { entry.enabled = enabled; });
}

export function setPluginAutoUpdate(configDir: string, name: string, autoUpdate: boolean): boolean {
  return setPluginField(configDir, name, (entry) => { entry.autoUpdate = autoUpdate; });
}

// Persists (or clears) a plugin's pinned commit so a downgrade survives the next
// earlyLaunch — otherwise the following run's normal pull would undo the pin.
// Best-effort: never throws.
export function setPluginCommitHash(configDir: string, name: string, commitHash: string | null): void {
  const file = getPluginsPath(configDir);
  try {
    if (!fs.existsSync(file)) return;
    const entries = JSON.parse(fs.readFileSync(file, "utf-8")) as Plugin[];
    if (!Array.isArray(entries)) return;
    const entry = entries.find((e) => e && e.name === name);
    if (!entry) return;
    if (commitHash) entry.commitHash = commitHash;
    else delete entry.commitHash;
    fs.writeFileSync(file, JSON.stringify(entries, null, 2), "utf8");
  } catch (e: unknown) {
    writeLog(`Failed to persist commitHash for ${name}: ${(e as { message: string }).message}`, true);
  }
}
