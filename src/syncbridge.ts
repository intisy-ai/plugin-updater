import { callCapability, DEFAULT_INVOKE_TIMEOUT_MS, readDeployedManifests, startPlugins } from "@intisy/bayonet/host";
import { createPluginRuntime, CROSS_APP_SYNC } from "@intisy-ai/basekit";
import type { CrossAppSyncCapability } from "@intisy-ai/basekit";
import { writeLog } from "./log.js";
import { getAppName, getPluginDir } from "./env.js";

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
