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

function getPluginConfig(): Record<string, unknown> {
  if (PLUGIN_CONFIG !== null) return PLUGIN_CONFIG;
  try {
    const isClaude = process.argv.join(" ").includes("claude");
    const appName = isClaude ? "claude" : "opencode";
    const configDir = getAppConfigDir(appName);
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
      const isClaude = process.argv.join(" ").includes("claude");
      const appName = isClaude ? "claude" : "opencode";
      const configDir = getAppConfigDir(appName);
      const logsDir = path.join(configDir, "logs", dateStr);
      if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
      const logFile = path.join(logsDir, `plugin-updater-${START_TIME}.log`);
      const prefix = isError ? "[ERROR]" : "[INFO]";
      fs.appendFileSync(logFile, `[${date.toISOString()}] ${prefix} ${message}\n`);
    }
  } catch { /* never crash on log failure */ }
  if (isError) console.error(message);
  else if (loggingEnabled) console.log(message);
}

function getReposDir(): string {
  const isClaude = process.argv.join(" ").includes("claude");
  const appName = isClaude ? "claude" : "opencode";
  return path.join(getAppConfigDir(appName), "repos");
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

function resolveNpmPluginVersion(name: string, configDir: string): string {
  try {
    const cacheDir = path.join(configDir, "cache", "node_modules");
    const globalNpm = process.platform === "win32"
      ? path.join(os.homedir(), "AppData", "Roaming", "npm", "node_modules")
      : path.join("/usr", "lib", "node_modules");
    const candidates = [
      path.join(cacheDir, name, "package.json"),
      path.join(configDir, "node_modules", name, "package.json"),
      path.join(globalNpm, name, "package.json"),
    ];
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

export function getNpmPlugins(configDir: string): NpmPlugin[] {
  const { plugins } = readOpencodeJson(configDir);
  return plugins.map((raw) => {
    const name = raw.replace(/@[^@/]+$/, "") || raw;
    const version = resolveNpmPluginVersion(name, configDir);
    return { name, version, installed: version !== "", raw };
  });
}

export function installNpmPlugin(name: string, configDir: string): string {
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
    executeGit(`git clone --recurse-submodules ${branchFlag} ${gitUrl} ${pluginName}`, reposDir);
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
      executeGit("git checkout main || git checkout master", targetDir);
      executeGit("git pull --ff-only", targetDir);
    }
    executeGit("git submodule update --init --recursive", targetDir);

    let afterHash = "";
    try { afterHash = execSync("git rev-parse HEAD", { cwd: targetDir }).toString().trim(); } catch { /* ignore */ }

    if (beforeHash !== afterHash) didChange = true;
  }
  return { success: true, changed: didChange };
}

function deployToExecutionDir(pluginName: string, executionPath: string, changed: boolean): boolean {
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
        writeLog(`Running npm install for ${pluginName}`);
        execSync("npm install", { cwd: sourceDir, stdio: "ignore" });
        writeLog(`Finished npm install for ${pluginName}`);

        const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { main?: string; scripts?: { build?: string } };
        if (pkg.main) entryFile = pkg.main;

        if (pkg.scripts?.build) {
          execSync("npm run build", { cwd: sourceDir, stdio: "ignore" });
          writeLog(`Finished npm run build for ${pluginName}`);
        } else {
          writeLog(`Skipped npm run build for ${pluginName} (no build script found)`);
        }
      } catch (error: unknown) {
        const err = error as { message: string };
        writeLog(`Build/Install failed for ${pluginName}: ${err.message}`, true);
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

  try {
    writeLog(`Running copy for ${pluginName}`);
    fs.copyFileSync(deploySource, pluginExecutionFile);
    writeLog(`Finished copy for ${pluginName}`);
  } catch (e: unknown) {
    const err = e as { message: string };
    writeLog(`Copy failed for ${pluginName}: ${err.message}`, true);
  }
  return true;
}

async function pluginUpdaterEntry(input: PluginUpdaterInput | null): Promise<void> {
  const isClaude = process.argv.join(" ").includes("claude");
  const appName = isClaude ? "claude" : "opencode";
  const configDir = getAppConfigDir(appName);
  const pluginsDir = path.join(configDir, "plugin");

  writeLog(`Starting plugin updater for ${appName}`);

  if (input?.action === "updatePlugin" && input.configDir && input.pluginName && input.gitUrl) {
    EARLY_LAUNCH_CONFIG_DIR = input.configDir;
    writeLog(`Direct update request for ${input.pluginName}`);
    const updateResult = updatePlugin(input.pluginName, input.gitUrl, input.branch, input.commitHash ?? null);
    deployToExecutionDir(input.pluginName, pluginsDir, updateResult.changed);
  }
}

export function updatePluginPublic(
  pluginName: string,
  gitUrl: string,
  branch?: string,
  commitHash?: string
): void {
  writeLog(`Public API update call for ${pluginName}`);
  const appName = process.argv.join(" ").includes("claude") ? "claude" : "opencode";
  const result = updatePlugin(pluginName, gitUrl, branch, commitHash ?? null);
  deployToExecutionDir(pluginName, path.join(getAppConfigDir(appName), "plugin"), result.changed);
}

export function earlyLaunch(configDir: string, plugins: Plugin[]): void {
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
    if (!plugin.enabled) continue;
    if (plugin.autoUpdate === false) continue;
    if (!plugin.url) continue;

    writeLog(`Processing earlyLaunch for ${plugin.name}`);
    try {
      const updateResult = updatePlugin(plugin.name, plugin.url, plugin.branch, null, plugin.updateInterval ?? 1);
      deployToExecutionDir(plugin.name, path.join(configDir, "plugin"), updateResult.changed);
    } catch (e: unknown) {
      const err = e as { message: string };
      writeLog(`Failed to process ${plugin.name}: ${err.message}`, true);
    }
  }
}

pluginUpdaterEntry(null);
