import fs from "node:fs";
import path from "node:path";
import type { PluginManifest } from "@intisy-ai/api";

/** Suffixes of the artifacts one deployed plugin owns in a home's plugin directory. */
export const DEPLOYED_SUFFIXES = [".js", ".json", ".sha"];

/** The manifest a clone declares, or null when it declares none or names nothing. */
export function readCloneManifest(sourceDir: string): PluginManifest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(sourceDir, "plugin.json"), "utf8"));
  } catch {
    return null;
  }
  const id = (parsed as { id?: unknown } | null)?.id;
  return typeof id === "string" && id.length > 0 ? (parsed as PluginManifest) : null;
}

/**
 * The id a plugin's deployed artifacts are named after.
 *
 * @remarks
 * The manifest's own id where a clone declares one, because identity belongs to the manifest; the
 * plugins.json name only says which directory it was read from.
 */
export function deployedIdFor(reposDir: string, pluginName: string): string {
  return readCloneManifest(path.join(reposDir, pluginName))?.id ?? pluginName;
}

/**
 * Keeps the deployed manifest sidecar equal to what the clone declares.
 *
 * @remarks
 * Called on every deploy pass, including the pass that copies nothing. A home whose plugins are
 * already current would otherwise never gain a sidecar, and a host answers every identity and
 * capability question from the sidecar alone.
 */
export function syncManifestSidecar(
  sourceDir: string,
  executionPath: string,
  deployedId: string,
  writeLog: (message: string, isError?: boolean) => void = () => {},
): "written" | "removed" | "none" {
  const target = path.join(executionPath, `${deployedId}.json`);
  const manifest = readCloneManifest(sourceDir);

  if (!manifest) {
    if (!fs.existsSync(target)) return "none";
    try {
      fs.unlinkSync(target);
      return "removed";
    } catch (error) {
      writeLog(`Could not remove the stale manifest for ${deployedId}: ${String(error)}`, true);
      return "none";
    }
  }

  try {
    fs.mkdirSync(executionPath, { recursive: true });
    fs.writeFileSync(target, JSON.stringify(manifest, null, 2), "utf8");
    return "written";
  } catch (error) {
    writeLog(`Could not write the manifest for ${deployedId}: ${String(error)}`, true);
    return "none";
  }
}
