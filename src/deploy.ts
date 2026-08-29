import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { execSync } from "child_process";
import { getAppName, getReposDir, setHostActivation } from "./env.js";
import { writeLog } from "./log.js";
import { buildInTempDir } from "./git.js";
import { startDeclaredDaemon } from "./daemon.js";
import { declaredLibraries, materializeLibraries, pruneAbandonedPluginStore, sharedStoreDir } from "./shared-libs.js";
import { readCloneManifest, syncManifestSidecar } from "./manifest.js";
// @ts-ignore - generated bundle, no .d.ts
import { deployBundle, deployEntryFile, repoHead } from "@intisy-ai/basekit";

// A loader plugin self-describes as one via its manifest's `app.loader.id` (see
// registerAppFromClone in index.ts), so this reads the clone's OWN manifest rather
// than the shared app registry — the registry only gains this entry AFTER deploy
// completes (registerAppFromClone runs post-deploy), so on a loader's first-ever
// install the registry wouldn't have it yet.
export function isLoaderPlugin(sourceDir: string, pluginName: string): boolean {
  return readCloneManifest(sourceDir)?.app?.loader?.id === pluginName;
}

export { deployEntryFile };

async function callPluginCleanup(pluginExecutionFile: string, configDir: string): Promise<void> {
  if (!fs.existsSync(pluginExecutionFile)) return;
  try {
    // pathToFileURL: on Windows an absolute path like C:\... is not a valid import
    // specifier ("protocol 'c:'") — the ESM loader needs a file:// URL.
    const mod = await import(pathToFileURL(pluginExecutionFile).href);
    if (typeof mod.cleanup === "function") {
      writeLog(`Calling cleanup() on ${pluginExecutionFile}`);
      await mod.cleanup(configDir);
      writeLog(`cleanup() complete for ${pluginExecutionFile}`);
    }
  } catch (e: unknown) {
    writeLog(`cleanup() call failed for ${pluginExecutionFile}: ${(e as { message: string }).message}`, true);
  }
}

// under claude, deployed plugins declare env/daemon in package.json#claudeHub;
// merge the env into settings.json so providers work without a login
function applyClaudeManifest(sourceDir: string, configDir: string, pluginName: string): void {
  if (getAppName() !== "claude") return;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(sourceDir, "package.json"), "utf8")) as {
      claudeHub?: { env?: Record<string, string> };
    };
    const manifest = pkg.claudeHub;
    if (!manifest?.env || typeof manifest.env !== "object") return;
    const settingsPath = path.join(configDir, "settings.json");
    let settings: Record<string, unknown> = {};
    try { settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>; } catch { /* fresh file */ }
    const env = (settings.env ?? {}) as Record<string, string>;
    for (const [key, value] of Object.entries(manifest.env)) {
      env[key] = String(value);
      writeLog(`settings.json env ${key} set by ${pluginName}`);
    }
    settings.env = env;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");
  } catch (e: unknown) {
    writeLog(`claudeHub manifest handling failed for ${pluginName}: ${(e as { message: string }).message}`, true);
  }
}

function readOrEmpty(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function importsByName(shipped: string, packageName: string): boolean {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`["'\`]${escaped}(/[^"'\`]*)?["'\`]`).test(shipped);
}

/**
 * Libraries the shipped code imports by name that the home's store cannot resolve.
 *
 * @remarks
 * Only the ones actually imported: a plugin that inlines its libraries at build time carries no
 * reference to them, so naming those would send it to a repair it does not need. This is worth
 * reporting even when the clone's own build is complete, because a bare import that does not
 * resolve is not a degraded plugin - it is a plugin that never loads.
 */
export function unresolvableLibraries(sourceDir: string, configDir: string, packageJsonPath: string): string[] {
  const declared = declaredLibraries(sourceDir);
  if (declared.length === 0) return [];

  const shipped = declaredEntryFiles(packageJsonPath).map((file) => readOrEmpty(path.join(sourceDir, file))).join("\n");
  return declared
    .filter((library: { specifier: string }) => importsByName(shipped, library.specifier))
    .filter((library: { specifier: string }) => !fs.existsSync(path.join(sharedStoreDir(configDir), ...library.specifier.split("/"), "package.json")))
    .map((library: { specifier: string }) => library.specifier);
}

// Every file a clone's package.json says it ships: the main entry, the plugin entry, and a
// provider's handlers. A plugin's main entry landing is not proof the build finished.
function declaredEntryFiles(packageJsonPath: string): string[] {
  let pkg: {
    main?: string;
    pluginEntry?: string;
    claudeHub?: { authProviders?: Array<{ handler?: string }> };
    authProviders?: Array<{ handler?: string }>;
  };
  try {
    pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  } catch {
    return [];
  }
  const declared = [
    pkg.main,
    pkg.pluginEntry,
    ...(pkg.claudeHub?.authProviders ?? pkg.authProviders ?? []).map((p) => p.handler),
  ].filter((f): f is string => typeof f === "string" && f.length > 0);
  return [...new Set(declared)];
}

// Files the clone says it ships but that the build did not produce: a clone missing a handler
// still loads while its accounts and routing do not work. Returned relative to the clone so the
// caller can name them.
export function missingDeclaredArtifacts(sourceDir: string, packageJsonPath: string): string[] {
  return declaredEntryFiles(packageJsonPath).filter((file) => !fs.existsSync(path.join(sourceDir, file)));
}

export async function deployToExecutionDir(pluginName: string, executionPath: string, changed: boolean, configDir: string): Promise<boolean> {
  const sourceDir = path.join(getReposDir(), pluginName);
  if (!fs.existsSync(sourceDir)) return false;

  const packageJsonPath = path.join(sourceDir, "package.json");
  const manifest = readCloneManifest(sourceDir);
  const deployedId = manifest?.id ?? pluginName;
  const pluginExecutionFile = path.join(executionPath, `${deployedId}.js`);
  const deployedExists = fs.existsSync(pluginExecutionFile);
  // Self-heal partial/failed prior deploys. `changed` only tracks whether the git
  // REMOTE moved this pass — but a clone can already sit at the target commit while the
  // DEPLOYED artifact is stale (an earlier pass advanced the clone but its build/copy
  // never landed). Without this, the fast-path below skips redeploy FOREVER and
  // activate() keeps regenerating from stale code. Stamp the deployed commit on every
  // successful copy and force a redeploy whenever it no longer matches the clone's HEAD.
  const deployedShaFile = path.join(executionPath, `${deployedId}.sha`);
  const head = repoHead(sourceDir);
  let deployedSha = "";
  try { deployedSha = fs.readFileSync(deployedShaFile, "utf8").trim(); } catch { /* never deployed / pre-sha install */ }
  const artifactStale = head !== "" && head !== deployedSha;
  if (artifactStale && deployedExists) writeLog(`Deployed ${pluginName} is stale (HEAD ${head.slice(0, 7)} != deployed ${deployedSha.slice(0, 7) || "none"}) — forcing redeploy`);
  // A clone can sit at the right commit with the right deployed entry and still be missing
  // another artifact its package.json declares, because a copy of that one file failed (on
  // Windows, a handler another process holds open cannot be overwritten). Check for that
  // here too, or the fast path below skips the only thing that would repair it.
  const incomplete = missingDeclaredArtifacts(sourceDir, packageJsonPath);
  if (incomplete.length > 0) writeLog(`Deployed ${pluginName} is missing ${incomplete.join(", ")} — forcing rebuild`, true);
  // Fast path: nothing changed, the deployed file is in place, AND it matches the clone's
  // HEAD. Skips the build/install AND (below) the copy + plugin re-import + re-activate,
  // which otherwise cost ~1s+ per plugin on EVERY launch and blocked startup.
  const nothingToDeploy = !changed && deployedExists && !artifactStale && incomplete.length === 0;

  let buildComplete = true;
  if (nothingToDeploy) {
    writeLog(`Skipping install/build for ${pluginName} (no changes and deployed file exists)`);
  } else if (fs.existsSync(packageJsonPath)) {
    try {
      buildInTempDir(pluginName, sourceDir);
      const runtimeDeps = (JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { dependencies?: Record<string, string> }).dependencies;
      if (runtimeDeps && Object.keys(runtimeDeps).length > 0) {
        writeLog(`Installing runtime dependencies for ${pluginName}`);
        execSync("npm install --omit=dev", { windowsHide: true, cwd: sourceDir, stdio: "pipe" });
        writeLog(`Finished runtime dependencies for ${pluginName}`);
      }
    } catch (error: unknown) {
      const err = error as { message: string; stderr?: Buffer; stdout?: Buffer };
      const stderr = err.stderr ? err.stderr.toString().trim() : "";
      const stdout = err.stdout ? err.stdout.toString().trim() : "";
      writeLog(`Build/Install failed for ${pluginName}: ${err.message}`, true);
      if (stderr) writeLog(`npm stderr: ${stderr}`, true);
      if (stdout) writeLog(`npm stdout: ${stdout}`, true);
      buildComplete = false;
    }
    const missing = missingDeclaredArtifacts(sourceDir, packageJsonPath);
    if (missing.length > 0) {
      writeLog(`Build for ${pluginName} left ${missing.join(", ")} missing; will rebuild on the next run`, true);
      buildComplete = false;
    }
  }

  // Outside the "did anything change" guard on purpose: a home installed before the libraries were
  // shared has no store at all, and nothing about it changes, so gating this would leave every
  // plugin there unable to resolve its imports forever. Re-running is cheap.
  materializeLibraries(sourceDir, configDir, writeLog);
  // Self-heals a home still shadowed by the store's old location (see pruneAbandonedPluginStore).
  pruneAbandonedPluginStore(executionPath, configDir, writeLog);
  // Asked AFTER the store was filled, so a hit means the install did not deliver what this
  // plugin's shipped code imports, rather than that the store had simply not been built yet.
  const unresolvable = unresolvableLibraries(sourceDir, configDir, packageJsonPath);
  if (unresolvable.length > 0) {
    writeLog(`${pluginName} imports ${unresolvable.join(", ")}, which the home's store does not carry; it will fail to load`, true);
  }

  if (nothingToDeploy) {
    // The sidecar is written even on this pass, since a host answers every identity and capability
    // question from it and a home whose plugins are current never enters the branch below.
    syncManifestSidecar(sourceDir, executionPath, deployedId, writeLog);
  } else {
    const deployed = await deployBundle(sourceDir, executionPath, pluginName, {
      // Only stamped when the build really landed: stamping over a half-built clone is what makes
      // the fast path skip it forever instead of retrying.
      head: buildComplete ? head : undefined,
      beforeOverwrite: (file) => callPluginCleanup(file, configDir),
      log: writeLog,
    });
    if (!deployed.ok) return deployedExists;
  }

  applyClaudeManifest(sourceDir, configDir, pluginName);
  await startDeclaredDaemon(sourceDir, configDir, pluginName);

  // Claude Code never imports deployed plugin files, so under claude the
  // updater is the runtime and invokes the plugin's activate() itself.
  // A loader ALSO needs activate() after any deploy — even under opencode —
  // because a TUI-driven self-update runs inside the `bun tui.js` process (not
  // opencode), so nothing else refreshes the oc/cc wrapper. Without this, the
  // wrapper keeps pointing at the stale/rebuilt TUI path and the command breaks
  // until the next app restart. activate() is idempotent (the activation guard makes
  // self-activation run at most once per process and tells the plugin one is already
  // in progress), so the extra call under opencode's normal launch is harmless.
  const isLoader = isLoaderPlugin(sourceDir, pluginName);
  // Claude: the updater IS the runtime, so it must import + activate() every launch.
  // OpenCode imports deployed plugins itself, so only loaders need activate() (to
  // refresh their oc/cc wrapper) and only when something deployed — the unchanged
  // fast path skips this entirely, which is the bulk of the startup speedup.
  const needActivate = getAppName() === "claude" ? true : (isLoader && !nothingToDeploy);
  if (needActivate) {
    try {
      // callPluginCleanup() above imported the OLD file at this path, poisoning
      // Node's ESM cache for it; the copy has since overwritten it with fresh code.
      // A cache-busting query forces a fresh module load so activate() runs the new
      // code (otherwise it regenerates the wrapper from the stale, cached module).
      const freshUrl = `${pathToFileURL(pluginExecutionFile).href}?v=${Date.now()}`;
      const deployed = await import(freshUrl);
      if (typeof deployed.activate === "function") {
        writeLog(`Activating ${pluginName}`);
        // tells the plugin an activation is being driven, so it must not start
        // another earlyLaunch and recurse back into the updater
        setHostActivation(true);
        try {
          await deployed.activate();
        } finally {
          setHostActivation(false);
        }
        writeLog(`Activated ${pluginName}`);
      }
    } catch (e: unknown) {
      writeLog(`Activation failed for ${pluginName}: ${(e as { message: string }).message}`, true);
    }
  }
  return true;
}
