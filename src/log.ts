// File + console logging delegated to the shared core logger, so plugin-updater's
// lines get the same `[plugin-updater]` prefix, per-plugin color, and GLOBAL console
// toggle (config/core.json logConsole / CORE_LOG_CONSOLE) as every other plugin.
// File logging still respects plugin-updater.json `logging`.
import fs from "fs";
import path from "path";
import { getAppConfigDir, getAppName } from "./env.js";
// @ts-ignore — generated bundle (core, esbuild-bundled to lib/ so it ships in the
// npm tarball; the submodule's own core/dist is gitignored and never published)
import { makeWriteLog } from "../lib/core.js";

let pluginConfig: Record<string, unknown> | null = null;

export function getPluginConfig(): Record<string, unknown> {
  if (pluginConfig !== null) return pluginConfig;
  try {
    const configDir = getAppConfigDir(getAppName());
    const preferred = path.join(configDir, "config", "plugin-updater.json");
    const fallback = path.join(configDir, "plugin-updater.json");
    const p = fs.existsSync(preferred) ? preferred : fs.existsSync(fallback) ? fallback : null;
    pluginConfig = p ? JSON.parse(fs.readFileSync(p, "utf8")) : {};
  } catch {
    pluginConfig = {};
  }
  return pluginConfig ?? {};
}

export const writeLog: (message: string, isError?: boolean) => void =
  makeWriteLog("plugin-updater", getAppConfigDir(getAppName()));
