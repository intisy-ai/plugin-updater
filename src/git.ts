import fs from "fs";
import path from "path";
import { execSync, exec } from "child_process";
import { promisify } from "util";
import { getReposDir } from "./env.js";
import { writeLog } from "./log.js";

const execAsync = promisify(exec);

// Fetch each plugin's remote HEAD hash CONCURRENTLY (network I/O) so earlyLaunch's
// per-plugin change check doesn't serialize N ls-remote round-trips — that was the
// dominant startup cost (~4s/plugin). Returns name -> remoteHash; a missing entry
// means "unknown", and updatePlugin then treats it as no-change (offline fallback).
export async function precomputeRemoteHashes(
  plugins: Array<{ name: string; url?: string; branch?: string; enabled?: boolean; commitHash?: string | null }>,
  timeoutMs = 20000,
): Promise<Map<string, string>> {
  const reposDir = getReposDir();
  const out = new Map<string, string>();
  await Promise.all((plugins || []).map(async (p) => {
    if (!p || !p.url || p.enabled === false || p.commitHash) return;
    const targetDir = path.join(reposDir, p.name);
    if (!fs.existsSync(targetDir)) return;   // never-cloned: updatePlugin does the clone
    try {
      const ref = p.branch || "HEAD";
      const { stdout } = await execAsync(`git ls-remote origin ${ref}`, {
        cwd: targetDir, timeout: timeoutMs,
        env: { ...process.env, GCM_INTERACTIVE: "never", GIT_TERMINAL_PROMPT: "0" },
      });
      out.set(p.name, String(stdout).trim().split(/\s+/)[0] || "");
    } catch { /* offline/transient — leave unset, updatePlugin falls back */ }
  }));
  return out;
}

// Asked of the URL rather than a clone, so a plugin that is not installed yet still gets an
// answer. A remote that cannot be reached is left OUT of the map: absent means unknown,
// which the resolver treats differently from a definite "no such branch".
export async function detectExperimentalBranches(
  plugins: Array<{ name: string; url?: string; enabled?: boolean; commitHash?: string | null }>,
  branch: string,
  timeoutMs = 20000,
): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  await Promise.all((plugins || []).map(async (p) => {
    if (!p || !p.url || p.enabled === false || p.commitHash) return;
    try {
      const { stdout } = await execAsync(`git ls-remote --heads ${p.url} ${branch}`, {
        timeout: timeoutMs,
        env: { ...process.env, GCM_INTERACTIVE: "never", GIT_TERMINAL_PROMPT: "0" },
      });
      out.set(p.name, String(stdout).trim().length > 0);
    } catch { /* unreachable remote: leave unset so the caller records unknown */ }
  }));
  return out;
}
// @ts-ignore — generated bundle, no .d.ts
import { loadConfig, fetchRepo, buildRepo, repoHead, runGit } from "@intisy-ai/basekit";

function getGitTimeoutMs(): number {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cfg = loadConfig("plugin-updater") as Record<string, any>;
  const seconds = typeof cfg.git_timeout_seconds === "number" ? cfg.git_timeout_seconds : 120;
  return seconds * 1000;
}

function getBuildTimeoutMs(): number {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cfg = loadConfig("plugin-updater") as Record<string, any>;
  const seconds = typeof cfg.build_timeout_seconds === "number" ? cfg.build_timeout_seconds : 300;
  return seconds * 1000;
}

// A host driving an install can show real transfer progress, but only if git streams it:
// git stays silent on a non-TTY unless asked, and the default capture holds stderr back for
// the error log. Opt in and stderr is inherited instead, so the host sees it live.
export function gitProgressStreaming(): boolean {
  return (process.env.PLUGIN_UPDATER_GIT_PROGRESS || "").trim() === "1";
}

export function gitProgressFlag(): string {
  return gitProgressStreaming() ? " --progress" : "";
}

export function executeGit(command: string, cwd: string): boolean {
  return runGit(command, cwd, { progress: gitProgressStreaming(), timeoutMs: getGitTimeoutMs(), log: writeLog });
}

export function updatePlugin(
  pluginName: string,
  gitUrl: string,
  branch: string | undefined,
  commitHash: string | null,
  updateInterval = 1,
  remoteHashHint?: string,
): { success: boolean; changed: boolean } {
  const reposDir = getReposDir();
  const targetDir = path.join(reposDir, pluginName);
  const lastCheckFile = path.join(targetDir, ".lastcheck");

  if (fs.existsSync(targetDir) && withinInterval(targetDir, lastCheckFile, updateInterval, commitHash, branch, remoteHashHint, pluginName)) {
    return { success: true, changed: false };
  }

  const fetched = fetchRepo(reposDir, pluginName, gitUrl, {
    ref: branch,
    commit: commitHash ?? undefined,
    progress: gitProgressStreaming(),
    timeoutMs: getGitTimeoutMs(),
    log: writeLog,
  });
  if (fetched.ok) fs.writeFileSync(lastCheckFile, Date.now().toString());
  return { success: fetched.ok, changed: fetched.changed };
}

/**
 * Whether the throttle still holds, so nothing needs fetching yet.
 *
 * @remarks
 * The interval throttles the expensive fetch and build, NOT change detection: a pinned commit is
 * intentional, and otherwise a cheap ls-remote picks a new push up on the very next launch instead
 * of waiting the interval out. Returns false, meaning "go and fetch", whenever it cannot tell.
 */
function withinInterval(
  targetDir: string,
  lastCheckFile: string,
  updateInterval: number,
  commitHash: string | null,
  branch: string | undefined,
  remoteHashHint: string | undefined,
  pluginName: string,
): boolean {
  const lastCheck = fs.existsSync(lastCheckFile) ? parseInt(fs.readFileSync(lastCheckFile, "utf8"), 10) : 0;
  const elapsed = Date.now() - lastCheck;
  if (elapsed >= updateInterval * 3_600_000) return false;

  let remoteMoved = false;
  if (!commitHash) {
    try {
      const ref = branch || "HEAD";
      // Prefer the hash precomputed in parallel; only pay for a serial ls-remote when no hint was
      // supplied, which is a plugin added after the pre-pass.
      const remoteHash = remoteHashHint !== undefined
        ? remoteHashHint
        : (execSync(`git ls-remote origin ${ref}`, { windowsHide: true, cwd: targetDir }).toString().trim().split(/\s+/)[0] || "");
      const localHash = repoHead(targetDir);
      remoteMoved = !!remoteHash && !!localHash && remoteHash !== localHash;
    } catch { /* offline or transient: fall back to skipping until the interval */ }
  }

  if (remoteMoved) {
    writeLog(`Fast-path: ${pluginName} remote moved - updating despite interval`);
    return false;
  }
  // NOTE: no per-launch `git submodule status --recursive` here. It spawns a git subprocess per
  // nested submodule and, under load, cost 10-17s PER PLUGIN, the dominant startup delay. Nothing
  // was rebuilt on this path, so pinned submodules are already correct.
  writeLog(`Fast-path: ${pluginName} skipping update check (checked ${Math.floor(elapsed / 60_000)} min ago, interval ${updateInterval}h)`);
  return true;
}

// on-disk local HEAD for the update-status cache; null when never cloned or on any git error
export function getLocalHead(pluginName: string): string | null {
  const targetDir = path.join(getReposDir(), pluginName);
  if (!fs.existsSync(targetDir)) return null;
  return repoHead(targetDir) || null;
}

export function buildInTempDir(pluginName: string, sourceDir: string): void {
  buildRepo(pluginName, sourceDir, { timeoutMs: getBuildTimeoutMs(), log: writeLog });
}
