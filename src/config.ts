import fs from "fs";
import path from "path";
import { isOpencodeHookInvocation } from "./env.js";
import { writeLog } from "./log.js";
import type { Plugin } from "./types.js";

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
      // Each loader is app-specific; never manage or show the OTHER app's loader even
      // if it was mistakenly registered here (e.g. a mixed-container init without --app).
      const isClaude = configDir.replace(/\\/g, "/").includes("/.claude");
      const foreignLoader = isClaude ? "opencode-loader" : "claude-code-loader";
      return entries.filter((e) => e && e.name !== foreignLoader);
    }
  } catch (e: unknown) {
    writeLog(`Failed to parse ${file}: ${(e as { message: string }).message}`, true);
  }
  return [];
}
