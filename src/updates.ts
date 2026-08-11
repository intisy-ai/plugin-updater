// The update surface every caller uses: a loader on app start, a dashboard in the
// background, or a human asking for it now. Every function takes the home explicitly,
// so this module knows nothing about any app.
import fs from "fs";
import path from "path";
import { writeLog } from "./log.js";
import { getPlugins, readOpencodeJson } from "./config.js";
import { precomputeRemoteHashes, detectExperimentalBranches, getLocalHead, updatePlugin } from "./git.js";
import { precomputeLatestNpmVersions, resolveNpmPluginVersion } from "./npm.js";
import {
  readUpdateCache,
  writeUpdateCache,
  recordCacheEntry,
  gitUpdateAvailable,
  npmUpdateAvailable,
  type UpdateCache,
} from "./cache.js";
import { emitUpdatesAvailable, emitPluginUpdated, emitPluginInstalled, emitPluginUpdateFailed, emitPluginProgress } from "./pluginActivity.js";
import { deployToExecutionDir } from "./deploy.js";
import { shouldPull, triggerEnabled, type Trigger } from "./policy.js";
import { readUpdaterConfig } from "./schema.js";
import { experimentalBranchName, resolveBranch } from "./channel.js";
import type { Plugin } from "./types.js";
import { getReposDir, getPluginDir } from "./env.js";

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
      experimentalAvailable: null,
    }, false, checkedAt);
  }

  const cfg = readUpdaterConfig(configDir);
  const branchName = experimentalBranchName(cfg);
  const detectedNow = await detectExperimentalBranches(list, branchName);
  const resolved = list.map((p) => ({
    ...p,
    branch: resolveBranch(p, cfg, detectedNow.get(p.name) ?? previousCache.plugins[p.name]?.experimentalAvailable ?? null),
  }));
  const remoteHashes = await precomputeRemoteHashes(resolved);
  for (const plugin of list) {
    const localHead = getLocalHead(plugin.name);
    const remoteHead = remoteHashes.get(plugin.name) ?? null;
    const updateAvailable = gitUpdateAvailable(localHead, remoteHead);
    if (updateAvailable) available.push(plugin.name);
    recordCacheEntry(cache, previousCache, plugin.name, {
      kind: "git", installedVersion: null, localHead, remoteHead, latestVersion: null, updateAvailable,
      experimentalAvailable: detectedNow.get(plugin.name) ?? previousCache.plugins[plugin.name]?.experimentalAvailable ?? null,
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
  return path.join(getReposDir(configDir), LOCK_NAME);
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
  try { fs.mkdirSync(getReposDir(configDir), { recursive: true }); } catch { /* the write below reports it */ }
  try {
    fs.writeFileSync(lockPath(configDir), JSON.stringify({ pid: process.pid, at: Date.now() }), "utf8");
  } catch { /* proceed unlocked rather than skipping the update entirely */ }
  try {
    return await fn();
  } finally {
    try { fs.unlinkSync(lockPath(configDir)); } catch { /* a leftover lock goes stale on its own */ }
  }
}

export interface UpdateOutcome {
  updated: string[];
  skipped: string[];
  failed: string[];
  checkedAt: string;
}

export interface PullOptions {
  trigger?: Trigger;
  plugins?: Plugin[];
  // the registry side-effect a fresh clone needs (a loader's cairn.json may have moved);
  // injected so this module never reaches back into the entry point
  afterInstall?: (name: string) => void;
  // when set, only these names are considered, and policy is ignored because a human asked
  only?: string[];
}

function emptyOutcome(checkedAt: string): UpdateOutcome {
  return { updated: [], skipped: [], failed: [], checkedAt };
}

// The one pull path. `only` means a human asked for it, so policy does not apply; without
// it every candidate is filtered through the home's mode and the plugin's own flag.
async function pullCandidates(configDir: string, check: CheckResult, opts: PullOptions): Promise<UpdateOutcome> {
  const cfg = readUpdaterConfig(configDir);
  const defaultIntervalHours = typeof cfg.default_update_interval_hours === "number" ? cfg.default_update_interval_hours : 1;
  const list = (opts.plugins ?? getPlugins(configDir)).filter(enabled);
  const byHuman = Array.isArray(opts.only);
  const outcome = emptyOutcome(check.checkedAt);
  const cache = check.cache;
  const previousCache = readUpdateCache(configDir);

  for (const plugin of list) {
    if (byHuman && !(opts.only as string[]).includes(plugin.name)) continue;
    if (!plugin.url) { outcome.skipped.push(plugin.name); continue; }
    const entry = cache.plugins[plugin.name];
    const alreadyCloned = fs.existsSync(path.join(getReposDir(configDir), plugin.name));
    if (alreadyCloned && entry && !entry.updateAvailable && !byHuman) continue;
    if (!byHuman && alreadyCloned && !shouldPull(cfg, plugin.autoUpdate)) {
      outcome.skipped.push(plugin.name);
      continue;
    }

    const previousVersion = alreadyCloned ? getLocalHead(plugin.name) : null;
    emitPluginProgress(plugin.name, alreadyCloned ? "updating" : "installing");
    try {
      const detected = previousCache.plugins[plugin.name]?.experimentalAvailable ?? null;
      const tracked = resolveBranch(plugin, cfg, detected);
      const result = updatePlugin(
        plugin.name, plugin.url, tracked, plugin.commitHash ?? null,
        byHuman ? 0 : (plugin.updateInterval ?? defaultIntervalHours),
        entry?.remoteHead ?? undefined,
      );
      const localHead = getLocalHead(plugin.name);
      recordCacheEntry(cache, previousCache, plugin.name, {
        kind: "git", installedVersion: null, localHead, remoteHead: entry?.remoteHead ?? null,
        latestVersion: null, updateAvailable: gitUpdateAvailable(localHead, entry?.remoteHead ?? null),
        experimentalAvailable: entry?.experimentalAvailable ?? null,
      }, result.changed, check.checkedAt);
      if (!result.success) {
        emitPluginUpdateFailed(plugin.name, new Error(`update failed for ${plugin.name} - see the updater log`));
        outcome.failed.push(plugin.name);
        continue;
      }
      await deployToExecutionDir(plugin.name, getPluginDir(configDir), result.changed, configDir);
      if (result.changed) {
        if (previousVersion !== null) emitPluginUpdated(plugin.name, previousVersion, localHead, byHuman ? "manual" : "launch");
        else emitPluginInstalled(plugin.name, localHead, byHuman ? "manual" : "launch");
        outcome.updated.push(plugin.name);
      }
      try { opts.afterInstall?.(plugin.name); } catch { /* registry work is best-effort */ }
    } catch (e: unknown) {
      writeLog(`Failed to update ${plugin.name}: ${(e as { message?: string }).message ?? e}`, true);
      emitPluginUpdateFailed(plugin.name, e);
      outcome.failed.push(plugin.name);
    }
  }

  writeUpdateCache(configDir, cache);
  return outcome;
}

// Startup path: a check always runs for an enabled trigger, and only the pull is gated.
export async function runAutoUpdate(configDir: string, opts: PullOptions & { trigger: Trigger }): Promise<UpdateOutcome> {
  const cfg = readUpdaterConfig(configDir);
  if (!triggerEnabled(cfg, opts.trigger)) {
    writeLog(`Skipping update run: the ${opts.trigger} trigger is off in ${configDir}`);
    return emptyOutcome(new Date().toISOString());
  }
  const result = await withUpdateLock(configDir, async () => {
    const check = await checkUpdates(configDir, opts.plugins);
    return pullCandidates(configDir, check, opts);
  });
  return result ?? emptyOutcome(new Date().toISOString());
}

// A human asked, so neither the mode nor the per-plugin flag applies.
export async function updateOne(configDir: string, name: string, opts: PullOptions = {}): Promise<UpdateOutcome> {
  const list = (opts.plugins ?? getPlugins(configDir)).filter(enabled);
  if (!list.some((p) => p.name === name)) throw new Error(`plugin not found: ${name}`);
  const result = await withUpdateLock(configDir, async () => {
    const check = await checkUpdates(configDir, opts.plugins);
    return pullCandidates(configDir, check, { ...opts, only: [name] });
  });
  return result ?? emptyOutcome(new Date().toISOString());
}

export async function updateAll(configDir: string, opts: PullOptions = {}): Promise<UpdateOutcome> {
  const result = await withUpdateLock(configDir, async () => {
    const check = await checkUpdates(configDir, opts.plugins);
    const names = (opts.plugins ?? getPlugins(configDir)).filter(enabled).map((p) => p.name);
    return pullCandidates(configDir, check, { ...opts, only: names });
  });
  return result ?? emptyOutcome(new Date().toISOString());
}
