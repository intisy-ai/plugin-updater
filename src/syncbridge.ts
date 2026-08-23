import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { callCapability, DEFAULT_INVOKE_TIMEOUT_MS, readDeployedManifests, startPlugins } from "@intisy-ai/plugin-host";
import { createPluginRuntime, CROSS_APP_SYNC } from "@intisy-ai/core";
import type { CrossAppSyncCapability } from "@intisy-ai/core";
import { writeLog } from "./log.js";
import { getAppName, getPluginDir, getReposDir } from "./env.js";

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

/**
 * Reconciles cross-app state before this launch reads the plugin list.
 *
 * @remarks
 * Resolved by capability, so the plugin answering is whichever one provides it and this module
 * names none. The scan is narrowed to the providers first: activating a whole home from inside a
 * launch sequence would activate this plugin too, and activating one plugin cannot recurse.
 *
 * A home with no provider is the ordinary first-run case, so it logs and returns rather than
 * failing. Nothing here throws: reconciliation is worth attempting, never worth blocking a launch.
 */
export async function syncAllAcrossApps(configDir: string): Promise<void> {
  try {
    const scan = readDeployedManifests(getPluginDir(configDir));
    const providers = scan.loaded.filter((plugin) => plugin.manifest.capabilities?.includes(CROSS_APP_SYNC.id));
    if (providers.length === 0) {
      writeLog("nothing provides cross-app sync in this home; skipping it");
      return;
    }
    const host = await startPlugins({
      app: getAppName(),
      pluginDir: getPluginDir(configDir),
      scan: { loaded: providers, failed: [] },
      vocabulary: [CROSS_APP_SYNC],
      runtimeFor: (manifest) => createPluginRuntime(manifest.id, configDir),
    });
    try {
      const [record] = host.host.capability(CROSS_APP_SYNC.id);
      if (!record) {
        writeLog("the cross-app sync provider did not register it; skipping the sync", true);
        return;
      }
      const answer = await callCapability(record.pluginId, "cross-app-sync.sync", DEFAULT_INVOKE_TIMEOUT_MS, async () =>
        (record.implementation as CrossAppSyncCapability).sync());
      if (answer.ok === false) {
        writeLog(`Cross-app sync failed: ${answer.error.detail}`, true);
        return;
      }
      writeLog(`Cross-app sync: ${JSON.stringify(answer.value)}`);
    } finally {
      await host.stop();
    }
  } catch (e: unknown) {
    writeLog(`Cross-app sync failed: ${(e as { message?: string })?.message ?? String(e)}`, true);
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
