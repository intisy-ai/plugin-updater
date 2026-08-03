import fs from "fs";
import path from "path";
import os from "os";
import { customAppHome } from "./apps.js";
// @ts-ignore — generated bundle, no .d.ts
import { currentAppId } from "../lib/core.js";

// set by earlyLaunch/direct-update so all path resolution targets that dir
let earlyLaunchConfigDir: string | null = null;

export function setEarlyLaunchConfigDir(dir: string): void {
  earlyLaunchConfigDir = dir;
}

// the CLI runs without "claude" in argv, so it forces the app via env
export function getAppName(): string {
  const override = process.env.PLUGIN_UPDATER_APP;
  if (override && override.trim()) return override.trim();
  // currentAppId() matches argv/env against the shared app registry, so it also
  // recognizes any custom app registered there (not just the two built-ins).
  const registered = currentAppId();
  if (registered) return registered;
  // Bootstrap fallback for a machine where nothing is registered yet (plugin-updater
  // itself is what registers apps, via a loader install — see registerAppFromClone).
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
  const custom = customAppHome(appName);
  if (custom) return custom;
  // Bootstrap fallback: no registry entry exists yet for this app (nothing has
  // registered it via cairn.json, see registerAppFromClone), so guess the two known
  // built-in layouts directly. Once a loader for this app has installed at least once,
  // customAppHome() above resolves it from the registry instead.
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
