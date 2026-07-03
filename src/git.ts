import fs from "fs";
import path from "path";
import os from "os";
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
// @ts-ignore — generated bundle, no .d.ts
import { loadConfig } from "../lib/core.js";

// dirs copied back from the temp build into the repo clone. core-loader/dist holds
// the loaders' TUI (tui.js), run as a separate process — without it `oc`/`cc` find
// no TUI and fall through to plain opencode/claude.
const BUILD_OUTPUT_DIRS = ["dist", path.join("core", "dist"), path.join("core-loader", "dist")];

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

export function executeGit(command: string, cwd: string): boolean {
  writeLog(`Executing git: ${command} in ${cwd}`);
  try {
    execSync(command, {
      cwd,
      stdio: "pipe",
      timeout: getGitTimeoutMs(),
      env: { ...process.env, GCM_INTERACTIVE: "never", GIT_TERMINAL_PROMPT: "0" },
    });
    return true;
  } catch (error: unknown) {
    const err = error as { message: string; stderr?: Buffer };
    const stderr = err.stderr ? err.stderr.toString().trim() : "";
    writeLog(`Git error in ${cwd}: ${err.message} | stderr: ${stderr}`, true);
    return false;
  }
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
  let didChange = false;

  if (!fs.existsSync(targetDir)) {
    if (!fs.existsSync(reposDir)) fs.mkdirSync(reposDir, { recursive: true });
    const branchFlag = branch ? `--branch ${branch}` : "";
    const cloned = executeGit(`git clone --recurse-submodules ${branchFlag} ${gitUrl} ${pluginName}`, reposDir);
    if (!cloned) return { success: false, changed: false };
    fs.writeFileSync(lastCheckFile, Date.now().toString());
    didChange = true;
  } else {
    const lastCheck = fs.existsSync(lastCheckFile)
      ? parseInt(fs.readFileSync(lastCheckFile, "utf8"), 10)
      : 0;
    const intervalMs = updateInterval * 3_600_000;
    const elapsed = Date.now() - lastCheck;

    if (elapsed < intervalMs) {
      // The interval throttles the expensive fetch/build, NOT change detection.
      // A pinned commit is intentional; otherwise do a cheap ls-remote so a new
      // push is picked up on the very next launch instead of waiting out the hour.
      let remoteMoved = false;
      if (!commitHash) {
        try {
          const ref = branch || "HEAD";
          // Prefer the hash precomputed in parallel (precomputeRemoteHashes); only
          // pay for a serial ls-remote here when no hint was supplied (e.g. a plugin
          // added after the pre-pass).
          const remoteHash = remoteHashHint !== undefined
            ? remoteHashHint
            : (execSync(`git ls-remote origin ${ref}`, { cwd: targetDir }).toString().trim().split(/\s+/)[0] || "");
          const localHash = execSync("git rev-parse HEAD", { cwd: targetDir }).toString().trim();
          remoteMoved = !!remoteHash && !!localHash && remoteHash !== localHash;
        } catch { /* offline / transient — fall back to skipping until the interval */ }
      }

      if (!remoteMoved) {
        writeLog(`Fast-path: ${pluginName} skipping update check (checked ${Math.floor(elapsed / 60_000)} min ago, interval ${updateInterval}h)`);
        // NOTE: no per-launch `git submodule status --recursive` here. It spawns a git
        // subprocess per nested submodule and, under load, cost 10-17s PER PLUGIN —
        // the dominant startup delay. On the fast path nothing was rebuilt, so pinned
        // submodules are already correct; the full-update path (interval elapsed or
        // remote moved) still runs submodule sync + rebuild. A drifted submodule with
        // no remote change is rare and self-heals on the next real update.
        return { success: true, changed: false };
      }

      writeLog(`Fast-path: ${pluginName} remote moved — updating despite interval`);
      // fall through to the full fetch/checkout/build path below
    }

    fs.writeFileSync(lastCheckFile, Date.now().toString());
    executeGit("git fetch origin", targetDir);

    let beforeHash = "";
    try { beforeHash = execSync("git rev-parse HEAD", { cwd: targetDir }).toString().trim(); } catch { /* ignore */ }

    if (commitHash) {
      executeGit(`git checkout ${commitHash}`, targetDir);
    } else if (branch) {
      executeGit(`git checkout ${branch}`, targetDir);
      executeGit(`git pull --ff-only origin ${branch}`, targetDir);
    } else {
      // the updater owns repos/: hard-sync to the remote so force-pushed
      // branches and rewritten submodule history cannot strand the clone
      executeGit("git fetch origin", targetDir);
      executeGit("git checkout main || git checkout master", targetDir);
      executeGit("git reset --hard @{upstream}", targetDir);
    }
    executeGit("git submodule sync --recursive", targetDir);
    const submodulesOk = executeGit("git submodule update --init --recursive --force", targetDir);
    if (!submodulesOk) {
      writeLog(`Submodule sync failed for ${pluginName}, recloning`, true);
      try { fs.rmSync(targetDir, { recursive: true, force: true }); } catch { /* ignore */ }
      const recloneBranchFlag = branch ? `--branch ${branch}` : "";
      executeGit(`git clone --recurse-submodules ${recloneBranchFlag} ${gitUrl} ${pluginName}`, reposDir);
      fs.writeFileSync(lastCheckFile, Date.now().toString());
      didChange = true;
    }

    let afterHash = "";
    try { afterHash = execSync("git rev-parse HEAD", { cwd: targetDir }).toString().trim(); } catch { /* ignore */ }

    if (beforeHash !== afterHash) didChange = true;
  }
  return { success: true, changed: didChange };
}

// npm install creates node_modules/.bin symlinks, which fail on filesystems
// without symlink support (e.g. Windows-backed Docker bind mounts) — build in
// the OS temp dir and copy the outputs back instead
export function buildInTempDir(pluginName: string, sourceDir: string): void {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `plugin-updater-${pluginName}-`));
  try {
    fs.cpSync(sourceDir, tempDir, {
      recursive: true,
      filter: (src) => {
        const name = path.basename(src);
        return name !== ".git" && name !== "node_modules";
      },
    });

    const buildTimeoutMs = getBuildTimeoutMs();
    writeLog(`Running npm install for ${pluginName}`);
    execSync("npm install", { cwd: tempDir, stdio: "pipe", timeout: buildTimeoutMs });
    writeLog(`Finished npm install for ${pluginName}`);

    const pkg = JSON.parse(fs.readFileSync(path.join(tempDir, "package.json"), "utf8")) as { scripts?: { build?: string } };
    if (pkg.scripts?.build) {
      execSync("npm run build", { cwd: tempDir, stdio: "pipe", timeout: buildTimeoutMs });
      writeLog(`Finished npm run build for ${pluginName}`);
    } else {
      writeLog(`Skipped npm run build for ${pluginName} (no build script found)`);
    }

    for (const outputDir of BUILD_OUTPUT_DIRS) {
      const builtDir = path.join(tempDir, outputDir);
      if (fs.existsSync(builtDir)) {
        fs.cpSync(builtDir, path.join(sourceDir, outputDir), { recursive: true });
      }
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
