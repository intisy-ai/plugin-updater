import path from "path";
import fs from "fs";
import { getReposDir, getPluginDir } from "./env.js";
import { writeLog } from "./log.js";
import { getLocalHead } from "./git.js";
import { deployToExecutionDir, missingDeclaredArtifacts } from "./deploy.js";

// A clone can be at the right commit and still be unusable: a build that half-landed leaves
// the main entry in place while another file the package.json declares is absent, and the
// plugin then loads with part of itself missing. This reports that state and rebuilds it.

export interface PluginHealth {
  name: string;
  cloned: boolean;
  deployed: boolean;
  // Files the clone's package.json declares that the build did not produce.
  missing: string[];
  healthy: boolean;
  head: string | null;
}

// The build outputs a plugin declares but does not have. Pure filesystem work, split
// out because the full health check spawns git for the head and callers that only
// want this were paying for a subprocess per plugin.
export function missingPluginArtifacts(configDir: string, name: string): string[] {
  const sourceDir = path.join(getReposDir(configDir), name);
  if (!fs.existsSync(sourceDir)) return [];
  return missingDeclaredArtifacts(sourceDir, path.join(sourceDir, "package.json"));
}

export function checkPluginHealth(configDir: string, name: string): PluginHealth {
  const sourceDir = path.join(getReposDir(configDir), name);
  const cloned = fs.existsSync(sourceDir);
  const deployed = fs.existsSync(path.join(getPluginDir(configDir), `${name}.js`));
  const missing = cloned ? missingDeclaredArtifacts(sourceDir, path.join(sourceDir, "package.json")) : [];
  return { name, cloned, deployed, missing, healthy: cloned && missing.length === 0, head: cloned ? getLocalHead(name) : null };
}

export function checkAllPluginHealth(configDir: string, names: string[]): PluginHealth[] {
  return names.map((name) => checkPluginHealth(configDir, name));
}

// Rebuilds and redeploys from the clone already on disk, without touching git: the commit is
// not what is wrong here, the build output is. Returns the state afterwards so a caller can
// tell a repair that worked from one that hit the same failure again.
export async function repairPlugin(configDir: string, name: string): Promise<PluginHealth> {
  const before = checkPluginHealth(configDir, name);
  if (!before.cloned) throw new Error(`plugin not installed: ${name}`);
  writeLog(`Repairing ${name}${before.missing.length > 0 ? ` (missing ${before.missing.join(", ")})` : ""}`);
  // changed: true is what forces the rebuild; the fast path exists precisely to skip it.
  await deployToExecutionDir(name, getPluginDir(configDir), true, configDir);
  const after = checkPluginHealth(configDir, name);
  if (after.healthy) writeLog(`Repaired ${name}`);
  else writeLog(`Repair of ${name} left ${after.missing.join(", ")} missing`, true);
  return after;
}
