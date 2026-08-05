// The update surface every caller uses: a loader on app start, a dashboard in the
// background, or a human asking for it now. Every function takes the home explicitly,
// so this module knows nothing about any app.
import fs from "fs";
import path from "path";
import { writeLog } from "./log.js";
import { getPlugins, readOpencodeJson } from "./config.js";
import { precomputeRemoteHashes, getLocalHead } from "./git.js";
import { precomputeLatestNpmVersions, resolveNpmPluginVersion } from "./npm.js";
import {
  readUpdateCache,
  writeUpdateCache,
  recordCacheEntry,
  gitUpdateAvailable,
  npmUpdateAvailable,
  type UpdateCache,
} from "./cache.js";
import { emitUpdatesAvailable } from "./pluginActivity.js";
import type { Plugin } from "./types.js";

export interface CheckResult {
  checkedAt: string;
  available: string[];
  cache: UpdateCache;
}

function enabled(plugin: Plugin): boolean {
  // absence of the enabled key means enabled, matching the loader TUI
  return plugin.enabled !== false;
}

// What is available, without touching a single clone. Writes the cache the loader TUI
// and the dashboard read, so a check is what makes a badge correct.
export async function checkUpdates(configDir: string, plugins?: Plugin[]): Promise<CheckResult> {
  const list = (plugins ?? getPlugins(configDir)).filter(enabled);
  const checkedAt = new Date().toISOString();
  const previousCache = readUpdateCache(configDir);
  const cache: UpdateCache = { checkedAt, plugins: {} };
  const available: string[] = [];

  const { plugins: npmNamesRaw } = readOpencodeJson(configDir);
  const npmNames = npmNamesRaw.map((raw) => raw.replace(/@[^@/]+$/, "") || raw);
  const npmLatest = await precomputeLatestNpmVersions(npmNames);
  for (const name of npmNames) {
    const installedVersion = resolveNpmPluginVersion(name, configDir) || null;
    const latestVersion = npmLatest.get(name) ?? null;
    const updateAvailable = npmUpdateAvailable(installedVersion, latestVersion);
    if (updateAvailable) available.push(name);
    recordCacheEntry(cache, previousCache, name, {
      kind: "npm", installedVersion, localHead: null, remoteHead: null, latestVersion, updateAvailable,
    }, false, checkedAt);
  }

  const remoteHashes = await precomputeRemoteHashes(list);
  for (const plugin of list) {
    const localHead = getLocalHead(plugin.name);
    const remoteHead = remoteHashes.get(plugin.name) ?? null;
    const updateAvailable = gitUpdateAvailable(localHead, remoteHead);
    if (updateAvailable) available.push(plugin.name);
    recordCacheEntry(cache, previousCache, plugin.name, {
      kind: "git", installedVersion: null, localHead, remoteHead, latestVersion: null, updateAvailable,
    }, false, checkedAt);
  }

  writeUpdateCache(configDir, cache);
  writeLog(`Checked updates for ${list.length + npmNames.length} plugins in ${configDir}: ${available.length} available`);
  if (available.length > 0) {
    try { emitUpdatesAvailable(available.length, available, configDir); } catch { /* never block a check */ }
  }
  return { checkedAt, available, cache };
}

const LOCK_NAME = ".update.lock";
const LOCK_STALE_MS = 15 * 60 * 1000;

function lockPath(configDir: string): string {
  return path.join(configDir, "repos", LOCK_NAME);
}

// Two processes pulling the same clone corrupt it, so a run either owns the lock or does
// not happen. A lock whose owner is gone, or one older than any real run, is taken over
// rather than blocking updates forever.
function heldByAnother(configDir: string): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(lockPath(configDir), "utf8")) as { pid?: number; at?: number };
    if (typeof raw.at === "number" && Date.now() - raw.at > LOCK_STALE_MS) return false;
    if (typeof raw.pid !== "number" || raw.pid === process.pid) return false;
    try { process.kill(raw.pid, 0); return true; } catch { return false; }
  } catch {
    return false;
  }
}

export async function withUpdateLock<T>(configDir: string, fn: () => Promise<T>): Promise<T | null> {
  if (heldByAnother(configDir)) {
    writeLog(`Another process is updating ${configDir}, skipping this run`);
    return null;
  }
  try { fs.mkdirSync(path.join(configDir, "repos"), { recursive: true }); } catch { /* the write below reports it */ }
  try {
    fs.writeFileSync(lockPath(configDir), JSON.stringify({ pid: process.pid, at: Date.now() }), "utf8");
  } catch { /* proceed unlocked rather than skipping the update entirely */ }
  try {
    return await fn();
  } finally {
    try { fs.unlinkSync(lockPath(configDir)); } catch { /* a leftover lock goes stale on its own */ }
  }
}
