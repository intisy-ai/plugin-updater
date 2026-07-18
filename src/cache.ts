import fs from "fs";
import path from "path";
import { writeLog } from "./log.js";

// Single source of truth for update state, read by the loader TUI to render the
// installed-plugins view synchronously (see the cache contract in the SP-E spec).
export interface CachePluginEntry {
  kind: "git" | "npm";
  installedVersion: string | null;
  localHead: string | null;   // git only
  remoteHead: string | null;  // git only
  latestVersion: string | null; // npm only (registry latest)
  updateAvailable: boolean;
  updatedAt: string | null; // set when THIS run actually applied an update
}

export interface UpdateCache {
  checkedAt: string;
  plugins: Record<string, CachePluginEntry>;
}

export function getCachePath(configDir: string): string {
  return path.join(configDir, "cache", "plugin-updates.json");
}

// Best-effort read of the PREVIOUS cache — used only to carry forward `updatedAt`
// for plugins not changed this run. Never throws; an absent/corrupt file yields empty.
export function readUpdateCache(configDir: string): UpdateCache {
  try {
    const parsed = JSON.parse(fs.readFileSync(getCachePath(configDir), "utf8")) as UpdateCache;
    if (parsed && typeof parsed === "object" && parsed.plugins && typeof parsed.plugins === "object") return parsed;
  } catch { /* absent / corrupt — start fresh */ }
  return { checkedAt: "", plugins: {} };
}

// Best-effort write — this cache is a display aid for the loader TUI, never load-bearing.
export function writeUpdateCache(configDir: string, cache: UpdateCache): void {
  try {
    const dir = path.join(configDir, "cache");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(getCachePath(configDir), JSON.stringify(cache, null, 2), "utf8");
  } catch (e: unknown) {
    writeLog(`Failed to write update cache: ${(e as { message?: string }).message ?? e}`, true);
  }
}

export function gitUpdateAvailable(localHead: string | null, remoteHead: string | null): boolean {
  return Boolean(localHead && remoteHead && localHead !== remoteHead);
}

// Lenient dotted-numeric compare for the "1.6.0" style versions used across the
// ecosystem; a non-numeric segment falls back to a string compare so an unusual
// version string never throws, it just compares reasonably. Returns -1/0/1.
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".");
  const pb = b.split(".");
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const sa = pa[i] ?? "0";
    const sb = pb[i] ?? "0";
    const na = Number(sa);
    const nb = Number(sb);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) {
      if (na !== nb) return na < nb ? -1 : 1;
    } else if (sa !== sb) {
      return sa < sb ? -1 : 1;
    }
  }
  return 0;
}

export function npmUpdateAvailable(installedVersion: string | null, latestVersion: string | null): boolean {
  if (!installedVersion || !latestVersion) return false;
  return compareVersions(latestVersion, installedVersion) > 0;
}

// Merges one plugin's freshly-computed row into `next`, carrying forward the
// previous run's `updatedAt` unless this run itself applied an update.
export function recordCacheEntry(
  next: UpdateCache,
  previous: UpdateCache,
  name: string,
  entry: Omit<CachePluginEntry, "updatedAt">,
  changedThisRun: boolean,
  checkedAt: string,
): void {
  const prevUpdatedAt = previous.plugins[name]?.updatedAt ?? null;
  next.plugins[name] = { ...entry, updatedAt: changedThisRun ? checkedAt : prevUpdatedAt };
}
