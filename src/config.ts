import fs from "fs";
import path from "path";
import { isOpencodeHookInvocation } from "./env.js";
import { writeLog } from "./log.js";
import type { Plugin } from "./types.js";

export function readOpencodeJson(configDir: string): { plugins: string[]; raw: Record<string, unknown> } {
  const ocPath = path.join(configDir, "opencode.json");
  if (!fs.existsSync(ocPath)) return { plugins: [], raw: {} };
  try {
    const stripped = fs.readFileSync(ocPath, "utf8").replace(/^\s*\/\/[^\n]*/gm, "");
    const parsed = JSON.parse(stripped) as Record<string, unknown>;
    const plugins = (parsed.plugin || []) as string[];
    return { plugins: plugins.filter((p) => typeof p === "string"), raw: parsed };
  } catch { return { plugins: [], raw: {} }; }
}

export function writeOpencodeJson(configDir: string, data: Record<string, unknown>): void {
  const ocPath = path.join(configDir, "opencode.json");
  fs.writeFileSync(ocPath, JSON.stringify(data, null, 2), "utf8");
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
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (e: unknown) {
    writeLog(`Failed to parse ${file}: ${(e as { message: string }).message}`, true);
  }
  return [];
}
