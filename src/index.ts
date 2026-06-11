import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";

interface Plugin {
  name: string;
  url?: string;
  branch?: string;
  enabled?: boolean;
  autoUpdate?: boolean;
  updateInterval?: number; // hours between git fetch checks, default 1
}

interface NpmPlugin {
  name: string;
  version: string;
  installed: boolean;
  raw: string;
}

interface PluginUpdaterInput {
  action: string;
  configDir?: string;
  pluginName?: string;
  gitUrl?: string;
  branch?: string;
  commitHash?: string;
}

let EARLY_LAUNCH_CONFIG_DIR: string | null = null;
let PLUGIN_CONFIG: Record<string, unknown> | null = null;
const START_TIME = new Date().toISOString().replace(/:/g, "-").split(".")[0];

// the CLI runs without "claude" in argv, so it forces the app via env
function getAppName(): string {
  const override = process.env.PLUGIN_UPDATER_APP;
  if (override === "claude" || override === "opencode") return override;
  return process.argv.join(" ").includes("claude") ? "claude" : "opencode";
}

function getPluginConfig(): Record<string, unknown> {
  if (PLUGIN_CONFIG !== null) return PLUGIN_CONFIG;
  try {
    const configDir = getAppConfigDir(getAppName());
    const preferred = path.join(configDir, "config", "plugin-updater.json");
    const fallback = path.join(configDir, "plugin-updater.json");
    const p = fs.existsSync(preferred) ? preferred : fs.existsSync(fallback) ? fallback : null;
    PLUGIN_CONFIG = p ? JSON.parse(fs.readFileSync(p, "utf8")) : {};
  } catch {
    PLUGIN_CONFIG = {};
  }
  return PLUGIN_CONFIG ?? {};
}

function getAppConfigDir(appName: string): string {
  if (EARLY_LAUNCH_CONFIG_DIR) return EARLY_LAUNCH_CONFIG_DIR;
  const home = os.homedir();
  const directPath = path.join(home, `.${appName}`);
  const configPath = path.join(home, ".config", appName);
  return fs.existsSync(directPath) ? directPath : configPath;
}

function writeLog(message: string, isError = false): void {
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

let NPM_GLOBAL_ROOT: string | null = null;

function getReposDir(): string {
  return path.join(getAppConfigDir(getAppName()), "repos");
}

function executeGit(command: string, cwd: string): boolean {
  writeLog(`Executing git: ${command} in ${cwd}`);
  try {
    execSync(command, {
      cwd,
      stdio: "pipe",
      env: { ...process.env, GCM_INTERACTIVE: "never", GIT_TERMINAL_PROMPT: "0" },
    });
    return true;
  } catch (error: unknown) {
    const err = error as { message: string; stderr?: Buffer };
    const stderr = err.stderr ? err.stderr.toString().trim() : "";
    writeLog(`Git error in ${cwd}: ${err.message} | stderr: ${stderr}`, true);
    return false;
  }
}

function getNpmGlobalRoot(): string {
  if (NPM_GLOBAL_ROOT !== null) return NPM_GLOBAL_ROOT;
  try {
    NPM_GLOBAL_ROOT = execSync("npm root -g", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    NPM_GLOBAL_ROOT = "";
  }
  return NPM_GLOBAL_ROOT;
}

function resolveNpmPluginVersion(name: string, configDir: string): string {
  try {
    // opencode installs npm plugins into ~/.cache/opencode/packages/<name>@<spec>/
    const packageCache = path.join(os.homedir(), ".cache", "opencode", "packages");
    if (fs.existsSync(packageCache)) {
      for (const entry of fs.readdirSync(packageCache)) {
        if (entry !== name && !entry.startsWith(`${name}@`)) continue;
        const cachedPkg = path.join(packageCache, entry, "node_modules", name, "package.json");
        if (fs.existsSync(cachedPkg)) {
          return JSON.parse(fs.readFileSync(cachedPkg, "utf8")).version || "";
        }
      }
    }
    const cacheDir = path.join(configDir, "cache", "node_modules");
    const globalNpm = getNpmGlobalRoot();
    const candidates = [
      path.join(cacheDir, name, "package.json"),
      path.join(configDir, "node_modules", name, "package.json"),
      globalNpm ? path.join(globalNpm, name, "package.json") : "",
    ].filter((p) => p !== "");
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        return JSON.parse(fs.readFileSync(p, "utf8")).version || "";
      }
    }
    // Try resolving via node resolution as last resort
    try {
      const resolved = require.resolve(path.join(name, "package.json"));
      return JSON.parse(fs.readFileSync(resolved, "utf8")).version || "";
    } catch { /* not resolvable */ }
  } catch { /* ignore */ }
  return "";
}

function readOpencodeJson(configDir: string): { plugins: string[]; raw: Record<string, unknown> } {
  const ocPath = path.join(configDir, "opencode.json");
  if (!fs.existsSync(ocPath)) return { plugins: [], raw: {} };
  try {
    const stripped = fs.readFileSync(ocPath, "utf8").replace(/^\s*\/\/[^\n]*/gm, "");
    const parsed = JSON.parse(stripped) as Record<string, unknown>;
    const plugins = (parsed.plugin || []) as string[];
    return { plugins: plugins.filter((p) => typeof p === "string"), raw: parsed };
  } catch { return { plugins: [], raw: {} }; }
}

function writeOpencodeJson(configDir: string, data: Record<string, unknown>): void {
  const ocPath = path.join(configDir, "opencode.json");
  fs.writeFileSync(ocPath, JSON.stringify(data, null, 2), "utf8");
}

// ── Public API ────────────────────────────────────────────────────────────────

// opencode invokes every exported function as a plugin hook, passing a context
// object instead of our protocol arguments; exports detect that and return an
// inert value so opencode gets a valid (empty) plugin instance
function isOpencodeHookInvocation(firstArgument: unknown): boolean {
  return typeof firstArgument !== "string";
}

export function getNpmPlugins(configDir: string): NpmPlugin[] {
  if (isOpencodeHookInvocation(configDir)) return [];
  const { plugins } = readOpencodeJson(configDir);
  return plugins.map((raw) => {
    const name = raw.replace(/@[^@/]+$/, "") || raw;
    const version = resolveNpmPluginVersion(name, configDir);
    return { name, version, installed: version !== "", raw };
  });
}

export function installNpmPlugin(name: string, configDir: string): string {
  if (isOpencodeHookInvocation(name)) return "";
  writeLog(`Installing npm plugin: ${name}`);
  try {
    const { plugins, raw } = readOpencodeJson(configDir);
    if (!plugins.includes(name)) {
      (raw.plugin as string[] | undefined) = [...plugins, name];
      writeOpencodeJson(configDir, raw);
    }
    execSync(`npm install -g ${name}`, { stdio: "pipe" });
    writeLog(`Installed npm plugin: ${name}`);
    return "";
  } catch (e: unknown) {
    const msg = (e as { message: string }).message;
    writeLog(`Failed to install ${name}: ${msg}`, true);
    return msg;
  }
}

export function uninstallNpmPlugin(name: string, configDir: string): string {
  if (isOpencodeHookInvocation(name)) return "";
  writeLog(`Uninstalling npm plugin: ${name}`);
  try {
    const { plugins, raw } = readOpencodeJson(configDir);
    (raw.plugin as string[] | undefined) = plugins.filter((p) => {
      const pName = p.replace(/@[^@/]+$/, "") || p;
      return pName !== name;
    });
    writeOpencodeJson(configDir, raw);
    execSync(`npm uninstall -g ${name}`, { stdio: "pipe" });
    writeLog(`Uninstalled npm plugin: ${name}`);
    return "";
  } catch (e: unknown) {
    const msg = (e as { message: string }).message;
    writeLog(`Failed to uninstall ${name}: ${msg}`, true);
    return msg;
  }
}

export function updateNpmPlugin(name: string, configDir: string, updateInterval = 1): string {
  if (isOpencodeHookInvocation(name)) return "";
  writeLog(`Updating npm plugin: ${name}`);
  const checkFile = path.join(configDir, "cache", `.npm-lastcheck-${name.replace(/[^a-z0-9]/gi, "_")}`);
  try {
    if (!fs.existsSync(path.join(configDir, "cache"))) {
      fs.mkdirSync(path.join(configDir, "cache"), { recursive: true });
    }
    const lastCheck = fs.existsSync(checkFile)
      ? parseInt(fs.readFileSync(checkFile, "utf8"), 10)
      : 0;
    const elapsed = Date.now() - lastCheck;
    if (elapsed < updateInterval * 3_600_000) {
      writeLog(`Skipping npm update for ${name} (checked ${Math.floor(elapsed / 60_000)} min ago)`);
      return "";
    }
    fs.writeFileSync(checkFile, Date.now().toString());
    execSync(`npm update -g ${name}`, { stdio: "pipe" });
    writeLog(`Updated npm plugin: ${name}`);
    return "";
  } catch (e: unknown) {
    const msg = (e as { message: string }).message;
    writeLog(`Failed to update ${name}: ${msg}`, true);
    return msg;
  }
}

function selfUpdate(configDir: string): void {
  writeLog("Running self-update for plugin-updater");
  updateNpmPlugin("plugin-updater", configDir);
}

function updatePlugin(
  pluginName: string,
  gitUrl: string,
  branch: string | undefined,
  commitHash: string | null,
  updateInterval = 1
): { success: boolean; changed: boolean } {
  const reposDir = getReposDir();
  const targetDir = path.join(reposDir, pluginName);
  const lastCheckFile = path.join(targetDir, ".lastcheck");
  let didChange = false;

  if (!fs.existsSync(targetDir)) {
    if (!fs.existsSync(reposDir)) fs.mkdirSync(reposDir, { recursive: true });
    const branchFlag = branch ? `--branch ${branch}` : "";
    const cloned = executeGit(`git clone --recurse-submodules ${branchFlag} ${gitUrl} ${pluginName}`, reposDir);
    if (!cloned) return { success: false, changed: false };
    fs.writeFileSync(lastCheckFile, Date.now().toString());
    didChange = true;
  } else {
    const lastCheck = fs.existsSync(lastCheckFile)
      ? parseInt(fs.readFileSync(lastCheckFile, "utf8"), 10)
      : 0;
    const intervalMs = updateInterval * 3_600_000;
    const elapsed = Date.now() - lastCheck;

    if (elapsed < intervalMs) {
      writeLog(`Fast-path: ${pluginName} skipping update check (checked ${Math.floor(elapsed / 60_000)} min ago, interval ${updateInterval}h)`);
      return { success: true, changed: false };
    }

    fs.writeFileSync(lastCheckFile, Date.now().toString());
    executeGit("git fetch origin", targetDir);

    let beforeHash = "";
    try { beforeHash = execSync("git rev-parse HEAD", { cwd: targetDir }).toString().trim(); } catch { /* ignore */ }

    if (commitHash) {
      executeGit(`git checkout ${commitHash}`, targetDir);
    } else if (branch) {
      executeGit(`git checkout ${branch}`, targetDir);
      executeGit(`git pull --ff-only origin ${branch}`, targetDir);
    } else {
      // the updater owns repos/: hard-sync to the remote so force-pushed
      // branches and rewritten submodule history cannot strand the clone
      executeGit("git fetch origin", targetDir);
      executeGit("git checkout main || git checkout master", targetDir);
      executeGit("git reset --hard @{upstream}", targetDir);
    }
    executeGit("git submodule sync --recursive", targetDir);
    const submodulesOk = executeGit("git submodule update --init --recursive --force", targetDir);
    if (!submodulesOk) {
      writeLog(`Submodule sync failed for ${pluginName}, recloning`, true);
      try { fs.rmSync(targetDir, { recursive: true, force: true }); } catch { /* ignore */ }
      const recloneBranchFlag = branch ? `--branch ${branch}` : "";
      executeGit(`git clone --recurse-submodules ${recloneBranchFlag} ${gitUrl} ${pluginName}`, reposDir);
      fs.writeFileSync(lastCheckFile, Date.now().toString());
      didChange = true;
    }

    let afterHash = "";
    try { afterHash = execSync("git rev-parse HEAD", { cwd: targetDir }).toString().trim(); } catch { /* ignore */ }

    if (beforeHash !== afterHash) didChange = true;
  }
  return { success: true, changed: didChange };
}

async function callPluginCleanup(pluginExecutionFile: string, configDir: string): Promise<void> {
  if (!fs.existsSync(pluginExecutionFile)) return;
  try {
    const mod = await import(pluginExecutionFile);
    if (typeof mod.cleanup === "function") {
      writeLog(`Calling cleanup() on ${pluginExecutionFile}`);
      await mod.cleanup(configDir);
      writeLog(`cleanup() complete for ${pluginExecutionFile}`);
    }
  } catch (e: unknown) {
    writeLog(`cleanup() call failed for ${pluginExecutionFile}: ${(e as { message: string }).message}`, true);
  }
}

const BUILD_OUTPUT_DIRS = ["dist", path.join("core", "dist")];

// npm install creates node_modules/.bin symlinks, which fail on filesystems
// without symlink support (e.g. Windows-backed Docker bind mounts) — build in
// the OS temp dir and copy the outputs back instead
function buildInTempDir(pluginName: string, sourceDir: string): void {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `plugin-updater-${pluginName}-`));
  try {
    fs.cpSync(sourceDir, tempDir, {
      recursive: true,
      filter: (src) => {
        const name = path.basename(src);
        return name !== ".git" && name !== "node_modules";
      },
    });

    writeLog(`Running npm install for ${pluginName}`);
    execSync("npm install", { cwd: tempDir, stdio: "pipe" });
    writeLog(`Finished npm install for ${pluginName}`);

    const pkg = JSON.parse(fs.readFileSync(path.join(tempDir, "package.json"), "utf8")) as { scripts?: { build?: string } };
    if (pkg.scripts?.build) {
      execSync("npm run build", { cwd: tempDir, stdio: "pipe" });
      writeLog(`Finished npm run build for ${pluginName}`);
    } else {
      writeLog(`Skipped npm run build for ${pluginName} (no build script found)`);
    }

    for (const outputDir of BUILD_OUTPUT_DIRS) {
      const builtDir = path.join(tempDir, outputDir);
      if (fs.existsSync(builtDir)) {
        fs.cpSync(builtDir, path.join(sourceDir, outputDir), { recursive: true });
      }
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function deployToExecutionDir(pluginName: string, executionPath: string, changed: boolean, configDir: string): Promise<boolean> {
  const sourceDir = path.join(getReposDir(), pluginName);
  if (!fs.existsSync(sourceDir)) return false;

  const packageJsonPath = path.join(sourceDir, "package.json");
  let entryFile = "index.js";
  const pluginExecutionFile = path.join(executionPath, `${pluginName}.js`);

  if (!changed && fs.existsSync(pluginExecutionFile)) {
    writeLog(`Skipping install/build for ${pluginName} (no changes and deployed file exists)`);
  } else {
    if (fs.existsSync(packageJsonPath)) {
      try {
        buildInTempDir(pluginName, sourceDir);
        const runtimeDeps = (JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { dependencies?: Record<string, string> }).dependencies;
        if (runtimeDeps && Object.keys(runtimeDeps).length > 0) {
          writeLog(`Installing runtime dependencies for ${pluginName}`);
          execSync("npm install --omit=dev", { cwd: sourceDir, stdio: "pipe" });
          writeLog(`Finished runtime dependencies for ${pluginName}`);
        }
      } catch (error: unknown) {
        const err = error as { message: string; stderr?: Buffer; stdout?: Buffer };
        const stderr = err.stderr ? err.stderr.toString().trim() : "";
        const stdout = err.stdout ? err.stdout.toString().trim() : "";
        writeLog(`Build/Install failed for ${pluginName}: ${err.message}`, true);
        if (stderr) writeLog(`npm stderr: ${stderr}`, true);
        if (stdout) writeLog(`npm stdout: ${stdout}`, true);
      }
    }
  }

  if (fs.existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { main?: string };
      if (pkg.main) entryFile = pkg.main;
    } catch { /* ignore */ }
  }

  const distPath = path.join(sourceDir, "dist");
  let deploySource = path.join(sourceDir, entryFile);

  if (fs.existsSync(path.join(distPath, entryFile))) {
    deploySource = path.join(distPath, entryFile);
  } else if (fs.existsSync(path.join(distPath, "index.js"))) {
    deploySource = path.join(distPath, "index.js");
  }

  if (!fs.existsSync(executionPath)) fs.mkdirSync(executionPath, { recursive: true });

  await callPluginCleanup(pluginExecutionFile, configDir);

  try {
    writeLog(`Running copy for ${pluginName}`);
    fs.copyFileSync(deploySource, pluginExecutionFile);
    writeLog(`Finished copy for ${pluginName}`);
  } catch (e: unknown) {
    const err = e as { message: string };
    writeLog(`Copy failed for ${pluginName}: ${err.message}`, true);
  }

  applyClaudeManifest(sourceDir, configDir, pluginName);
  await startDeclaredDaemon(sourceDir, configDir, pluginName);

  // Claude Code never imports deployed plugin files, so under claude the
  // updater is the runtime and invokes the plugin's activate() itself
  if (getAppName() === "claude") {
    try {
      const deployed = await import(pluginExecutionFile);
      if (typeof deployed.activate === "function") {
        writeLog(`Activating ${pluginName}`);
        // tells the plugin the updater is the caller, so it must not start
        // another earlyLaunch and recurse back into the updater
        process.env.PLUGIN_UPDATER_ACTIVATION = "1";
        try {
          await deployed.activate();
        } finally {
          delete process.env.PLUGIN_UPDATER_ACTIVATION;
        }
        writeLog(`Activated ${pluginName}`);
      }
    } catch (e: unknown) {
      writeLog(`Activation failed for ${pluginName}: ${(e as { message: string }).message}`, true);
    }
  }
  return true;
}

function applyClaudeManifest(sourceDir: string, configDir: string, pluginName: string): void {
  if (getAppName() !== "claude") return;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(sourceDir, "package.json"), "utf8")) as {
      claudeHub?: { env?: Record<string, string>; daemon?: { script?: string } };
    };
    const manifest = pkg.claudeHub;
    if (!manifest) return;
    if (manifest.env && typeof manifest.env === "object") {
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
    }
  } catch (e: unknown) {
    writeLog(`claudeHub manifest handling failed for ${pluginName}: ${(e as { message: string }).message}`, true);
  }
}

interface DaemonManifest {
  script: string;
  runtime?: string;
  port?: number;
  healthCheckUrl?: string;
}

async function isDaemonHealthy(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

// idempotent: health-check the declared endpoint, spawn detached only if down.
// the daemon outlives this process so the proxy persists across the session.
async function startDeclaredDaemon(sourceDir: string, configDir: string, pluginName: string): Promise<void> {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(sourceDir, "package.json"), "utf8")) as { claudeHub?: { daemon?: DaemonManifest } };
    const daemon = pkg.claudeHub?.daemon;
    if (!daemon?.script) return;

    const healthUrl = daemon.healthCheckUrl
      || (daemon.port ? `http://127.0.0.1:${daemon.port}/health` : "");
    if (healthUrl && (await isDaemonHealthy(healthUrl))) {
      writeLog(`Daemon for ${pluginName} already running`);
      return;
    }

    const scriptPath = path.join(sourceDir, daemon.script);
    if (!fs.existsSync(scriptPath)) {
      writeLog(`Daemon script missing for ${pluginName}: ${scriptPath}`, true);
      return;
    }

    const runtime = daemon.runtime || "node";
    const { spawn } = await import("child_process");
    const child = spawn(runtime, [scriptPath], {
      cwd: sourceDir,
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        HUB_CONFIG_DIR: configDir,
        HUB_APP_NAME: getAppName() === "claude" ? "Claude Code" : "OpenCode",
        ...(daemon.port ? { HUB_PROXY_PORT: String(daemon.port) } : {}),
      },
    });
    child.unref();
    writeLog(`Started daemon for ${pluginName} (${runtime} ${daemon.script})`);
  } catch (e: unknown) {
    writeLog(`Daemon start failed for ${pluginName}: ${(e as { message: string }).message}`, true);
  }
}

async function pluginUpdaterEntry(input: PluginUpdaterInput | null): Promise<void> {
  const appName = getAppName();
  const configDir = getAppConfigDir(appName);
  const pluginsDir = path.join(configDir, "plugin");

  writeLog(`Starting plugin updater for ${appName}`);

  if (input?.action === "updatePlugin" && input.configDir && input.pluginName && input.gitUrl) {
    EARLY_LAUNCH_CONFIG_DIR = input.configDir;
    writeLog(`Direct update request for ${input.pluginName}`);
    const updateResult = updatePlugin(input.pluginName, input.gitUrl, input.branch, input.commitHash ?? null);
    await deployToExecutionDir(input.pluginName, pluginsDir, updateResult.changed, input.configDir);
  }
}

export async function updatePluginPublic(
  pluginName: string,
  gitUrl: string,
  branch?: string,
  commitHash?: string
): Promise<void | object> {
  if (isOpencodeHookInvocation(pluginName)) return {};
  writeLog(`Public API update call for ${pluginName}`);
  const configDir = getAppConfigDir(getAppName());
  // interval 0: an explicit update request must never fast-path-skip
  const result = updatePlugin(pluginName, gitUrl, branch, commitHash ?? null, 0);
  if (!result.success) throw new Error(`could not set up ${pluginName} - see the updater log`);
  await deployToExecutionDir(pluginName, path.join(configDir, "plugin"), result.changed, configDir);
}

export async function earlyLaunch(configDir: string, plugins: Plugin[]): Promise<void | object> {
  if (isOpencodeHookInvocation(configDir)) return {};
  EARLY_LAUNCH_CONFIG_DIR = configDir;
  writeLog("Starting earlyLaunch updater sequence");

  // Self-update first
  selfUpdate(configDir);

  // Update npm plugins listed in opencode.json
  const { plugins: npmNames } = readOpencodeJson(configDir);
  for (const raw of npmNames) {
    const name = raw.replace(/@[^@/]+$/, "") || raw;
    if (name === "plugin-updater") continue; // already self-updated above
    writeLog(`npm earlyLaunch update for ${name}`);
    try {
      updateNpmPlugin(name, configDir);
    } catch (e: unknown) {
      writeLog(`Failed npm update for ${name}: ${(e as { message: string }).message}`, true);
    }
  }

  // Git plugins
  if (!plugins || !Array.isArray(plugins)) {
    writeLog("No git plugins provided to earlyLaunch", true);
    return;
  }

  for (const plugin of plugins) {
    // absence of the enabled key means enabled, matching the loader TUI
    if (plugin.enabled === false) { writeLog(`Skipping disabled plugin ${plugin.name}`); continue; }
    if (plugin.autoUpdate === false) { writeLog(`Skipping auto-update for ${plugin.name} (autoUpdate off)`); continue; }
    if (!plugin.url) { writeLog(`Skipping ${plugin.name}: no url in plugins.json`, true); continue; }

    writeLog(`Processing earlyLaunch for ${plugin.name}`);
    try {
      const updateResult = updatePlugin(plugin.name, plugin.url, plugin.branch, null, plugin.updateInterval ?? 1);
      if (!updateResult.success) {
        writeLog(`Skipping deploy for ${plugin.name}: update failed`, true);
        continue;
      }
      await deployToExecutionDir(plugin.name, path.join(configDir, "plugin"), updateResult.changed, configDir);
    } catch (e: unknown) {
      const err = e as { message: string };
      writeLog(`Failed to process ${plugin.name}: ${err.message}`, true);
    }
  }
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
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (e: unknown) {
    writeLog(`Failed to parse ${file}: ${(e as { message: string }).message}`, true);
  }
  return [];
}

export async function activate(opencodeHookInput?: unknown): Promise<void | object> {
  // module load below calls activate() with no argument; opencode passes a
  // context object when re-invoking the export — return an inert plugin instance
  if (opencodeHookInput !== undefined) return {};
  const appName = getAppName();
  const configDir = getAppConfigDir(appName);
  writeLog(`Plugin updater activating for ${appName}`);

  const gitPlugins = getPlugins(configDir);
  writeLog(`Found ${gitPlugins.length} git plugins in plugins.json`);
  await earlyLaunch(configDir, gitPlugins);
}

// consumers like the loader TUI import this module for its API only — running
// the full updater sequence on import would print over their screen
if (process.env.PLUGIN_UPDATER_LIBRARY_MODE !== "1") activate();
