import fs from "fs";
import path from "path";
import os from "os";

// set by earlyLaunch/direct-update so all path resolution targets that dir
let earlyLaunchConfigDir: string | null = null;

export function setEarlyLaunchConfigDir(dir: string): void {
  earlyLaunchConfigDir = dir;
}

// the CLI runs without "claude" in argv, so it forces the app via env
export function getAppName(): string {
  const override = process.env.PLUGIN_UPDATER_APP;
  if (override === "claude" || override === "opencode") return override;
  return process.argv.join(" ").includes("claude") ? "claude" : "opencode";
}

export function getAppConfigDir(appName: string): string {
  if (earlyLaunchConfigDir) return earlyLaunchConfigDir;
  // HUB_CONFIG_DIR is the loader's forced config dir (the unified top-priority signal,
  // matching core/core-auth). The loader's in-process update path spawns us as a child
  // that inherits it — honor it so single-plugin updates target the loader's real
  // repos/plugin dir instead of guessing ~/.<app> from argv.
  const hub = (process.env.HUB_CONFIG_DIR || "").trim();
  if (hub) return hub;
  const home = os.homedir();
  const directPath = path.join(home, `.${appName}`);
  if (appName === "claude") return directPath;
  // opencode prefers the XDG home whenever it exists (matches the app itself and
  // sync-bridge); a leftover ~/.opencode must never hijack resolution.
  const configPath = path.join(home, ".config", appName);
  return fs.existsSync(configPath) || !fs.existsSync(directPath) ? configPath : directPath;
}

export function getReposDir(): string {
  return path.join(getAppConfigDir(getAppName()), "repos");
}

// opencode invokes every exported function as a plugin hook, passing a context
// object instead of our protocol arguments; exports detect that and return an
// inert value so opencode gets a valid (empty) plugin instance
export function isOpencodeHookInvocation(firstArgument: unknown): boolean {
  return typeof firstArgument !== "string";
}
