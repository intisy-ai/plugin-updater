import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import { isOpencodeHookInvocation } from "./env.js";
import { writeLog } from "./log.js";
import { readOpencodeJson, writeOpencodeJson } from "./config.js";
import type { NpmPlugin } from "./types.js";

let npmGlobalRoot: string | null = null;

export function getNpmGlobalRoot(): string {
  if (npmGlobalRoot !== null) return npmGlobalRoot;
  try {
    npmGlobalRoot = execSync("npm root -g", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    npmGlobalRoot = "";
  }
  return npmGlobalRoot;
}

export function resolveNpmPluginVersion(name: string, configDir: string): string {
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
    try {
      const resolved = require.resolve(path.join(name, "package.json"));
      return JSON.parse(fs.readFileSync(resolved, "utf8")).version || "";
    } catch { /* not resolvable */ }
  } catch { /* ignore */ }
  return "";
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

export function selfUpdate(configDir: string): void {
  writeLog("Running self-update for plugin-updater");
  updateNpmPlugin("plugin-updater", configDir);
}
