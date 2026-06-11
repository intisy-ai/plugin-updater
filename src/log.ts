import fs from "fs";
import path from "path";
import { getAppConfigDir, getAppName } from "./env.js";

const START_TIME = new Date().toISOString().replace(/:/g, "-").split(".")[0];
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

export function writeLog(message: string, isError = false): void {
  const loggingEnabled = getPluginConfig().logging !== false;
  try {
    if (loggingEnabled) {
      const date = new Date();
      const dateStr = date.toISOString().split("T")[0];
      const configDir = getAppConfigDir(getAppName());
      const logsDir = path.join(configDir, "logs", dateStr);
      if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
      const logFile = path.join(logsDir, `plugin-updater-${START_TIME}.log`);
      const prefix = isError ? "[ERROR]" : "[INFO]";
      fs.appendFileSync(logFile, `[${date.toISOString()}] ${prefix} ${message}\n`);
    }
  } catch { /* never crash on log failure */ }
  if (process.env.PLUGIN_UPDATER_LIBRARY_MODE === "1" && process.env.PLUGIN_UPDATER_CLI !== "1") return;
  if (isError) console.error(message);
  else if (loggingEnabled) console.log(message);
}
