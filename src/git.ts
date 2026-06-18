import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import { getReposDir } from "./env.js";
import { writeLog } from "./log.js";

const BUILD_OUTPUT_DIRS = ["dist", path.join("core", "dist")];

export function executeGit(command: string, cwd: string): boolean {
  writeLog(`Executing git: ${command} in ${cwd}`);
  try {
    execSync(command, {
      cwd,
      stdio: "pipe",
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
  updateInterval = 1
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
          const remoteHash = execSync(`git ls-remote origin ${ref}`, { cwd: targetDir }).toString().trim().split(/\s+/)[0] || "";
          const localHash = execSync("git rev-parse HEAD", { cwd: targetDir }).toString().trim();
          remoteMoved = !!remoteHash && !!localHash && remoteHash !== localHash;
        } catch { /* offline / transient — fall back to skipping until the interval */ }
      }

      if (!remoteMoved) {
        writeLog(`Fast-path: ${pluginName} skipping update check (checked ${Math.floor(elapsed / 60_000)} min ago, interval ${updateInterval}h)`);
        // even when skipping the network check, keep embedded submodules pinned to
        // this checkout — a loader running against a stale core/core-auth is the
        // top cause of "looks broken but it's just stale". Rebuild if they moved.
        if (fs.existsSync(path.join(targetDir, ".gitmodules"))) {
          // Cheap LOCAL drift check first: `git submodule status` prefixes a line
          // with '+' when the submodule is off its pinned commit and '-' when it is
          // uninitialized. Only pay for the expensive recursive sync/update when one
          // of those is true — otherwise this ran a full submodule update on every
          // plugin every launch, which was the bulk of the startup delay.
          let status = "";
          try { status = execSync("git submodule status --recursive", { cwd: targetDir }).toString(); } catch { /* ignore */ }
          const drifted = status.split("\n").some((line) => line.startsWith("+") || line.startsWith("-"));
          if (drifted) {
            executeGit("git submodule sync --recursive", targetDir);
            executeGit("git submodule update --init --recursive", targetDir);
            writeLog(`Fast-path: ${pluginName} submodules were out of sync — resynced, forcing rebuild`);
            return { success: true, changed: true };
          }
        }
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

    writeLog(`Running npm install for ${pluginName}`);
    execSync("npm install", { cwd: tempDir, stdio: "pipe" });
    writeLog(`Finished npm install for ${pluginName}`);

    const pkg = JSON.parse(fs.readFileSync(path.join(tempDir, "package.json"), "utf8")) as { scripts?: { build?: string } };
    if (pkg.scripts?.build) {
      execSync("npm run build", { cwd: tempDir, stdio: "pipe" });
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
