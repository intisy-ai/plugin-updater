import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { execSync } from "child_process";
import { getAppName, getReposDir, setHostActivation } from "./env.js";
import { writeLog } from "./log.js";
import { buildInTempDir } from "./git.js";
import { startDeclaredDaemon } from "./daemon.js";
import { materializeLibraries, unbuiltLibraries } from "./shared-libs.js";
import type { PluginManifest } from "@intisy-ai/api";
import { readCloneManifest, syncManifestSidecar } from "./manifest.js";

// The clone's current commit, used to tie a deployed artifact to the source it was
// built from (self-heals a stale deploy left by an earlier interrupted pass).
function repoHead(dir: string): string {
  try { return execSync("git rev-parse HEAD", { windowsHide: true, cwd: dir, encoding: "utf8" }).trim(); } catch { return ""; }
}

// A loader plugin self-describes as one via cairn.json's `app.loader.id` (see
// registerAppFromClone in index.ts), so this reads the clone's OWN manifest rather
// than the shared app registry — the registry only gains this entry AFTER deploy
// completes (registerAppFromClone runs post-deploy), so on a loader's first-ever
// install the registry wouldn't have it yet.
export function isLoaderPlugin(sourceDir: string, pluginName: string): boolean {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(sourceDir, "cairn.json"), "utf8")) as {
      app?: { loader?: { id?: string } };
    };
    return manifest.app?.loader?.id === pluginName;
  } catch {
    return false;
  }
}

// A plugin is deployed as ONE file next to its siblings-free execution dir, so a repo whose
// npm entry is a multi-file tsc dist declares a self-contained bundle as `pluginEntry`.
// Without that the deployed file imports modules that were never copied, and anything that
// loads it (an app hook, the `config schema` probe behind every settings screen) fails. The
// manifest's `entry` is asked first, since the manifest is what states which module a host imports.
export function deployEntryFile(pkg: { main?: string; pluginEntry?: string }, manifest?: PluginManifest | null): string {
  if (manifest?.entry) return manifest.entry;
  if (typeof pkg.pluginEntry === "string" && pkg.pluginEntry) return pkg.pluginEntry;
  if (typeof pkg.main === "string" && pkg.main) return pkg.main;
  return "index.js";
}

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

// An unbuilt library is only this plugin's problem when its shipped code still imports it by
// name: a plugin that inlines its libraries at build time carries no reference to them and
// runs fine with the submodule unbuilt, so calling it broken would send it to a repair it
// does not need. The entry files are read only once a library already looks unbuilt, which
// keeps the healthy case to a handful of existsSync calls.
function unimportableLibraries(sourceDir: string, entryFiles: string[]): string[] {
  const unbuilt = unbuiltLibraries(sourceDir);
  if (unbuilt.length === 0) return [];

  const shipped = entryFiles.map((file) => readOrEmpty(path.join(sourceDir, file))).join("\n");
  return unbuilt
    .filter((library) => importsByName(shipped, library.specifier))
    .map((library) => path.posix.join(path.relative(sourceDir, library.dir).split(path.sep).join("/"), "dist"));
}

// Files the clone says it ships but that the build did not produce. A plugin's main entry
// landing is not proof the build finished: a provider also declares handlers, and a clone
// missing one still loads while its accounts and routing do not work. Returned relative to
// the clone so the caller can name them.
export function missingDeclaredArtifacts(sourceDir: string, packageJsonPath: string): string[] {
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
  const entryFiles = [...new Set(declared)];
  const missing = entryFiles.filter((file) => !fs.existsSync(path.join(sourceDir, file)));
  return [...missing, ...unimportableLibraries(sourceDir, entryFiles)];
}

export async function deployToExecutionDir(pluginName: string, executionPath: string, changed: boolean, configDir: string): Promise<boolean> {
  const sourceDir = path.join(getReposDir(), pluginName);
  if (!fs.existsSync(sourceDir)) return false;

  const packageJsonPath = path.join(sourceDir, "package.json");
  const manifest = readCloneManifest(sourceDir);
  const deployedId = manifest?.id ?? pluginName;
  let entryFile = "index.js";
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
  // A library the clone declares but never built cannot be put in the home's store, so the
  // plugin that imports it by name fails to load. Only a build produces it, and the fast path
  // is what skips that build, which is why such a home never repaired itself on any launch.
  const unbuilt = unbuiltLibraries(sourceDir);
  if (unbuilt.length > 0) writeLog(`${pluginName} declares ${unbuilt.map((l) => l.specifier).join(", ")} with no build output — forcing rebuild`, true);
  const nothingToDeploy = !changed && deployedExists && !artifactStale && incomplete.length === 0 && unbuilt.length === 0;

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

  if (fs.existsSync(packageJsonPath)) {
    try {
      entryFile = deployEntryFile(JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { main?: string; pluginEntry?: string }, manifest);
    } catch { /* ignore */ }
  }

  const distPath = path.join(sourceDir, "dist");
  // pkg.main frequently already carries the dist/ prefix (e.g. "dist/plugin.js"), so
  // resolve it against sourceDir DIRECTLY — that is the correct artifact. Only fall back
  // to dist/ when that primary path is missing, and use the BASENAME so we never re-join
  // "dist/plugin.js" onto dist/ (which double-nests to dist/dist/plugin.js and can pick
  // up a stale leftover from an older layout — the cause of silent stale deploys).
  let deploySource = path.join(sourceDir, entryFile);
  if (!fs.existsSync(deploySource)) {
    const base = path.basename(entryFile);
    if (fs.existsSync(path.join(distPath, base))) {
      deploySource = path.join(distPath, base);
    } else if (fs.existsSync(path.join(distPath, "index.js"))) {
      deploySource = path.join(distPath, "index.js");
    }
  }

  // the build may have produced nothing (e.g. it failed, or the repo was deployed
  // bundle-only with its source stripped) — skip gracefully rather than throwing
  // ENOENT on the copy. Any already-deployed plugin/<name>.js stays in place.
  // Only touch the deployed file when something actually changed — the cleanup
  // imports the old module and the copy rewrites it, both pointless when unchanged.
  // Outside the "did anything change" guard on purpose: a home installed before the
  // libraries were shared has no store at all, and nothing about it changes, so
  // gating this would leave every plugin there unable to resolve its imports
  // forever. Re-running is cheap, since an up-to-date library is left alone.
  materializeLibraries(sourceDir, configDir, writeLog);

  // Outside the "did anything change" guard for the same reason the store above is: a home whose
  // plugins are already current never enters that branch, and a host with no sidecar cannot see
  // the plugin at all.
  const sidecar = syncManifestSidecar(sourceDir, executionPath, deployedId, writeLog);
  if (sidecar !== "none") writeLog(`Manifest for ${deployedId} ${sidecar}`);

  if (!nothingToDeploy) {
    if (!fs.existsSync(deploySource)) {
      writeLog(`Skipping deploy for ${pluginName}: built file not found at ${deploySource}`, true);
      return deployedExists;
    }
    if (!fs.existsSync(executionPath)) fs.mkdirSync(executionPath, { recursive: true });
    // Deployed plugin files are esbuild ESM bundles. Without a package.json declaring the
    // dir ESM, Node re-parses each on import and warns (MODULE_TYPELESS_PACKAGE_JSON).
    // Drop a one-time marker so imports are clean.
    try {
      const pkgMarker = path.join(executionPath, "package.json");
      if (!fs.existsSync(pkgMarker)) fs.writeFileSync(pkgMarker, JSON.stringify({ type: "module" }, null, 2), "utf8");
    } catch { /* non-fatal */ }
    await callPluginCleanup(pluginExecutionFile, configDir);
    try {
      writeLog(`Running copy for ${pluginName}`);
      fs.copyFileSync(deploySource, pluginExecutionFile);
      // Stamp the commit this artifact was built from AFTER a successful copy, so a
      // later pass can tell whether the deployed file is current (see artifactStale).
      // Only when the build really landed: stamping over a half-built clone is what
      // makes the fast path skip it forever instead of retrying.
      try { if (head && buildComplete) fs.writeFileSync(deployedShaFile, head, "utf8"); } catch { /* non-fatal */ }
      writeLog(`Finished copy for ${pluginName}`);
    } catch (e: unknown) {
      writeLog(`Copy failed for ${pluginName}: ${(e as { message: string }).message}`, true);
    }
  }

  applyClaudeManifest(sourceDir, configDir, pluginName);
  await startDeclaredDaemon(sourceDir, configDir, pluginName);

  // Claude Code never imports deployed plugin files, so under claude the
  // updater is the runtime and invokes the plugin's activate() itself.
  // A loader ALSO needs activate() after any deploy — even under opencode —
  // because a TUI-driven self-update runs inside the `bun tui.js` process (not
  // opencode), so nothing else refreshes the oc/cc wrapper. Without this, the
  // wrapper keeps pointing at the stale/rebuilt TUI path and the command breaks
  // until the next app restart. activate() is idempotent (installs the wrapper,
  // earlyLaunch is guarded by PLUGIN_UPDATER_ACTIVATION), so the extra call under
  // opencode's normal launch is harmless.
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
