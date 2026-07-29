import { existsSync, statSync, readFileSync } from "fs";
import { join } from "path";
import os from "os";

export interface AppHome {
  envOverride?: string;
  nativeEnv?: string;
  xdgSubdir?: string;
  candidates: string[];
}
export interface AppEntry {
  id: string;
  label?: string;
  home: AppHome;
}

const BUILTIN_IDS = new Set(["claude", "opencode"]);

let CACHE: Record<string, AppEntry> | null = null;
let CACHE_KEY = "";

function trimmed(v?: string): string {
  return v && v.trim() ? v.trim() : "";
}

export function resolveAppsFile(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  const override = trimmed(env.HUB_APPS_FILE);
  if (override) return override;
  return join(home, ".config", "cairn", "apps.json");
}

function readRegistered(env: NodeJS.ProcessEnv, home: string): Record<string, AppEntry> {
  const file = resolveAppsFile(env, home);
  let mtime = 0;
  try { mtime = existsSync(file) ? statSync(file).mtimeMs : 0; } catch { mtime = 0; }
  const key = file + "::" + mtime;
  if (CACHE && CACHE_KEY === key) return CACHE;
  let data: Record<string, AppEntry> = {};
  try {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, "utf-8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed;
    }
  } catch { data = {}; }
  CACHE = data;
  CACHE_KEY = key;
  return data;
}

function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(home, p.slice(2));
  return p;
}

export function customAppHome(appName: string, env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string | null {
  if (BUILTIN_IDS.has(appName)) return null;
  const entry = readRegistered(env, home)[appName];
  if (!entry || !entry.home || !Array.isArray(entry.home.candidates)) return null;
  const over = entry.home.envOverride ? trimmed(env[entry.home.envOverride]) : "";
  if (over) return over;
  const native = entry.home.nativeEnv ? trimmed(env[entry.home.nativeEnv]) : "";
  if (native) return native;
  if (entry.home.xdgSubdir) {
    const xdg = trimmed(env.XDG_CONFIG_HOME);
    if (xdg) return join(xdg, entry.home.xdgSubdir);
  }
  const cands = entry.home.candidates.map((c) => expandHome(c, home));
  for (const c of cands) if (existsSync(c)) return c;
  return cands[cands.length - 1] ?? null;
}

export function registeredAppIds(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string[] {
  return Object.keys(readRegistered(env, home)).filter((id) => !BUILTIN_IDS.has(id));
}
