import fs from "fs";
import path from "path";
import os from "os";
import { customAppHome } from "./apps.js";
// @ts-ignore — generated bundle, no .d.ts
import { currentAppId, appPaths, getAppDescriptor } from "@intisy-ai/core";
import type { AppPaths } from "@intisy-ai/core";

// set by earlyLaunch/direct-update so all path resolution targets that dir
let earlyLaunchConfigDir: string | null = null;

export function setEarlyLaunchConfigDir(dir: string | null): void {
  earlyLaunchConfigDir = dir;
}

/** The home a run has stated, or null while none has. */
export function getEarlyLaunchConfigDir(): string | null {
  return earlyLaunchConfigDir;
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
  // registered it from its manifest, see registerAppFromClone), so guess the two known
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

// The storage directories for a home, resolved from the app's registry entry so a
// renamed one takes effect everywhere at once. Never join the literal names.
export function getPaths(configDir: string = getAppConfigDir(getAppName())): AppPaths {
  return appPaths(configDir, getAppDescriptor(getAppName()) ?? null);
}

export function getReposDir(configDir?: string): string {
  return getPaths(configDir).repos;
}

export function getPluginDir(configDir?: string): string {
  return getPaths(configDir).plugin;
}

export function getCacheDir(configDir?: string): string {
  return getPaths(configDir).cache;
}

// opencode invokes every exported function as a plugin hook, passing a context
// object instead of our protocol arguments; exports detect that and return an
// inert value so opencode gets a valid (empty) plugin instance
export function isOpencodeHookInvocation(firstArgument: unknown): boolean {
  return typeof firstArgument !== "string";
}

// How a host tells a plugin what it is doing. The generic keys are the contract any plugin and any
// host may use; the vendor-named ones are read so a host deployed before them still suppresses
// this plugin, and written so such a host still recognises an activation it did not start.
const LIBRARY_MODE_KEYS = ["INTISY_PLUGIN_LIBRARY_MODE", "PLUGIN_UPDATER_LIBRARY_MODE"];
const ACTIVATION_KEYS = ["INTISY_PLUGIN_ACTIVATION", "PLUGIN_UPDATER_ACTIVATION"];

function anySet(keys: string[]): boolean {
  return keys.some((key) => process.env[key] === "1");
}

/** A host imported this module for its API and must not have an update sequence run at it. */
export function isLibraryMode(): boolean {
  return anySet(LIBRARY_MODE_KEYS);
}

/** Something is already driving an activation, so starting another would recurse. */
export function isHostActivation(): boolean {
  return anySet(ACTIVATION_KEYS);
}

/** States, or withdraws, that an activation is being driven from here. */
export function setHostActivation(on: boolean): void {
  for (const key of ACTIVATION_KEYS) {
    if (on) process.env[key] = "1";
    else delete process.env[key];
  }
}
