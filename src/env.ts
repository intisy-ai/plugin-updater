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
  const home = os.homedir();
  const directPath = path.join(home, `.${appName}`);
  const configPath = path.join(home, ".config", appName);
  return fs.existsSync(directPath) ? directPath : configPath;
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
