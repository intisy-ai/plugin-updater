import fs from "fs";
import path from "path";
import os from "os";
import { execSync, exec } from "child_process";
import { promisify } from "util";
import { getReposDir } from "./env.js";
import { writeLog } from "./log.js";
import { submoduleTree } from "./shared-libs.js";

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
import { loadConfig } from "@intisy-ai/core";

// The build happens in a temp copy, so a dist left there is a dist the clone never gets.
// Every submodule builds its own, and a hardcoded list silently dropped the ones nobody had
// added to it (core-auth, the vendor translators): the build succeeded, its output was
// discarded, and the plugin stayed broken through any number of repairs. Derived from
// .gitmodules for the same reason shared-libs derives the library set from it: adding a
// library is then a submodule and nothing else.
function buildOutputDirs(sourceDir: string): string[] {
  return ["dist", ...submoduleTree(sourceDir).map((relative) => path.join(relative, "dist"))];
}

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
  writeLog(`Executing git: ${command} in ${cwd}`);
  try {
    execSync(command, {
      windowsHide: true,
      cwd,
      stdio: gitProgressStreaming() ? ["ignore", "pipe", "inherit"] : "pipe",
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
    const cloned = executeGit(`git clone --recurse-submodules${gitProgressFlag()} ${branchFlag} ${gitUrl} ${pluginName}`, reposDir);
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
            : (execSync(`git ls-remote origin ${ref}`, { windowsHide: true, cwd: targetDir }).toString().trim().split(/\s+/)[0] || "");
          const localHash = execSync("git rev-parse HEAD", { windowsHide: true, cwd: targetDir }).toString().trim();
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
    executeGit(`git fetch origin${gitProgressFlag()}`, targetDir);

    let beforeHash = "";
    try { beforeHash = execSync("git rev-parse HEAD", { windowsHide: true, cwd: targetDir }).toString().trim(); } catch { /* ignore */ }

    if (commitHash) {
      executeGit(`git checkout ${commitHash}`, targetDir);
    } else if (branch) {
      executeGit(`git checkout ${branch}`, targetDir);
      // A force-pushed channel branch would leave a --ff-only pull refusing and the clone silently behind.
      executeGit(`git reset --hard origin/${branch}`, targetDir);
    } else {
      // the updater owns repos/: hard-sync to the remote so force-pushed
      // branches and rewritten submodule history cannot strand the clone
      executeGit(`git fetch origin${gitProgressFlag()}`, targetDir);
      executeGit("git checkout main || git checkout master", targetDir);
      executeGit("git reset --hard @{upstream}", targetDir);
    }
    executeGit("git submodule sync --recursive", targetDir);
    const submodulesOk = executeGit("git submodule update --init --recursive --force", targetDir);
    if (!submodulesOk) {
      writeLog(`Submodule sync failed for ${pluginName}, recloning`, true);
      try { fs.rmSync(targetDir, { recursive: true, force: true }); } catch { /* ignore */ }
      const recloneBranchFlag = branch ? `--branch ${branch}` : "";
      executeGit(`git clone --recurse-submodules${gitProgressFlag()} ${recloneBranchFlag} ${gitUrl} ${pluginName}`, reposDir);
      fs.writeFileSync(lastCheckFile, Date.now().toString());
      didChange = true;
    }

    let afterHash = "";
    try { afterHash = execSync("git rev-parse HEAD", { windowsHide: true, cwd: targetDir }).toString().trim(); } catch { /* ignore */ }

    if (beforeHash !== afterHash) didChange = true;
  }
  return { success: true, changed: didChange };
}

// on-disk local HEAD for the update-status cache; null when never cloned or on any git error
export function getLocalHead(pluginName: string): string | null {
  const targetDir = path.join(getReposDir(), pluginName);
  if (!fs.existsSync(targetDir)) return null;
  try {
    return execSync("git rev-parse HEAD", { windowsHide: true, cwd: targetDir }).toString().trim() || null;
  } catch {
    return null;
  }
}

const COPY_RETRIES = 12;
const COPY_RETRY_DELAY_MS = 250;

function copyFileWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.copyFileSync(from, to);
      return;
    } catch (e: unknown) {
      // On Windows a file a running process has open cannot be overwritten. A handler
      // another process imported is exactly that, so wait for it to let go rather than
      // leaving the built artifact behind.
      const code = (e as { code?: string }).code;
      if (attempt >= COPY_RETRIES || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw e;
      sleepSync(COPY_RETRY_DELAY_MS);
    }
  }
}

function sleepSync(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) { /* the build is synchronous throughout; nothing to yield to */ }
}

// One file at a time, so a single locked artifact cannot abandon the rest of the tree
// half-copied the way a recursive copy does.
function copyTree(from: string, to: string, pluginName: string): void {
  fs.mkdirSync(to, { recursive: true });
  const failures: string[] = [];
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copyTree(source, target, pluginName);
      continue;
    }
    try {
      copyFileWithRetry(source, target);
    } catch (e: unknown) {
      failures.push(`${entry.name} (${(e as { message: string }).message})`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`could not write ${failures.length} built file(s) for ${pluginName}: ${failures.join(", ")}`);
  }
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
    execSync("npm install", { windowsHide: true, cwd: tempDir, stdio: "pipe", timeout: buildTimeoutMs });
    writeLog(`Finished npm install for ${pluginName}`);

    const pkg = JSON.parse(fs.readFileSync(path.join(tempDir, "package.json"), "utf8")) as { scripts?: { build?: string } };
    if (pkg.scripts?.build) {
      // Said BEFORE the build, not only after: this is the longest step by far (a
      // provider transpiles Java through gradle here), and without it the progress
      // readout sat on the previous step's label for the whole thing.
      writeLog(`Running npm run build for ${pluginName}`);
      execSync("npm run build", { windowsHide: true, cwd: tempDir, stdio: "pipe", timeout: buildTimeoutMs });
      writeLog(`Finished npm run build for ${pluginName}`);
    } else {
      writeLog(`Skipped npm run build for ${pluginName} (no build script found)`);
    }

    // Read from the temp copy: a submodule the clone has not checked out yet still has its
    // .gitmodules there after npm install, and its dist only exists there.
    for (const outputDir of buildOutputDirs(tempDir)) {
      const builtDir = path.join(tempDir, outputDir);
      if (fs.existsSync(builtDir)) {
        // A built dist can be hundreds of megabytes, so this is worth naming too.
        writeLog(`Copying build output ${outputDir}/ for ${pluginName}`);
        copyTree(builtDir, path.join(sourceDir, outputDir), pluginName);
      }
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
