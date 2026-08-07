import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { writeLog } from "./log.js";
import { getReposDir } from "./env.js";

// sync-bridge is the only component allowed to span both app homes, so the
// cross-app plugin-list merge lives there. It ships its in-process API as a
// separate bundle (dist/lib.js) — the plugin hook (dist/index.js) deliberately
// exports nothing usable. We load that library from the cloned-plugin location
// where plugin-updater itself deploys git plugins.
function resolveSyncBridgeLib(configDir: string): string | null {
  const candidates = [
    path.join(getReposDir(configDir), "sync-bridge", "dist", "lib.js"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// Mirror every plugins.json entry flagged `sync: true` into the other app's
// plugins.json. A no-op (logged, never thrown) when sync-bridge isn't installed
// or is an older version without syncPlugins.
export async function syncPluginsAcrossApps(configDir: string): Promise<void> {
  const libPath = resolveSyncBridgeLib(configDir);
  if (!libPath) {
    writeLog("sync-bridge not installed; skipping cross-app plugin sync");
    return;
  }
  try {
    const bridge = (await import(pathToFileURL(libPath).href)) as { syncPlugins?: () => unknown };
    if (typeof bridge.syncPlugins !== "function") {
      writeLog("sync-bridge has no syncPlugins (older version); skipping cross-app plugin sync", true);
      return;
    }
    const result = bridge.syncPlugins();
    writeLog(`Cross-app plugin sync: ${JSON.stringify(result)}`);
  } catch (e: unknown) {
    writeLog(`Cross-app plugin sync failed: ${(e as { message: string }).message}`, true);
  }
}

// Drive the broadened cross-app sync (accounts + plugins + settings + per-plugin
// configs). Falls back to plugins-only sync when sync-bridge is an older version.
export async function syncAllAcrossApps(configDir: string): Promise<void> {
  const libPath = resolveSyncBridgeLib(configDir);
  if (!libPath) {
    writeLog("sync-bridge not installed; skipping cross-app sync");
    return;
  }
  try {
    const bridge = (await import(pathToFileURL(libPath).href)) as { syncAll?: () => unknown };
    if (typeof bridge.syncAll !== "function") {
      writeLog("sync-bridge has no syncAll (older version); falling back to plugin sync", true);
      await syncPluginsAcrossApps(configDir);
      return;
    }
    const result = bridge.syncAll();
    writeLog(`Cross-app sync: ${JSON.stringify(result)}`);
  } catch (e: unknown) {
    writeLog(`Cross-app sync failed: ${(e as { message: string }).message}`, true);
  }
}

// Read sync-bridge's coverage/status, or null when sync-bridge is absent or old.
export async function readSyncStatus(configDir: string): Promise<unknown | null> {
  const libPath = resolveSyncBridgeLib(configDir);
  if (!libPath) return null;
  try {
    const bridge = (await import(pathToFileURL(libPath).href)) as { syncStatus?: () => unknown };
    return typeof bridge.syncStatus === "function" ? bridge.syncStatus() : null;
  } catch {
    return null;
  }
}
