import fs from "fs";
import path from "path";
import { getAppName } from "./env.js";
import { writeLog } from "./log.js";
import type { DaemonManifest } from "./types.js";

async function isDaemonHealthy(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

// idempotent: health-check the declared endpoint, spawn detached only if down.
// the daemon outlives this process so the proxy persists across the session.
export async function startDeclaredDaemon(sourceDir: string, configDir: string, pluginName: string): Promise<void> {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(sourceDir, "package.json"), "utf8")) as { claudeHub?: { daemon?: DaemonManifest } };
    const daemon = pkg.claudeHub?.daemon;
    if (!daemon?.script) return;

    const healthUrl = daemon.healthCheckUrl
      || (daemon.port ? `http://127.0.0.1:${daemon.port}/health` : "");
    if (healthUrl && (await isDaemonHealthy(healthUrl))) {
      writeLog(`Daemon for ${pluginName} already running`);
      return;
    }

    const scriptPath = path.join(sourceDir, daemon.script);
    if (!fs.existsSync(scriptPath)) {
      writeLog(`Daemon script missing for ${pluginName}: ${scriptPath}`, true);
      return;
    }

    const runtime = daemon.runtime || "node";
    const { spawn } = await import("child_process");
    const child = spawn(runtime, [scriptPath], {
      cwd: sourceDir,
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        HUB_CONFIG_DIR: configDir,
        HUB_APP_NAME: getAppName() === "claude" ? "Claude Code" : "OpenCode",
        ...(daemon.port ? { HUB_PROXY_PORT: String(daemon.port) } : {}),
      },
    });
    child.unref();
    writeLog(`Started daemon for ${pluginName} (${runtime} ${daemon.script})`);
  } catch (e: unknown) {
    writeLog(`Daemon start failed for ${pluginName}: ${(e as { message: string }).message}`, true);
  }
}
