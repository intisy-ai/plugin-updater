#!/usr/bin/env node
process.env.PLUGIN_UPDATER_LIBRARY_MODE = "1";
process.env.PLUGIN_UPDATER_CLI = "1";

import fs from "fs";
import path from "path";
import os from "os";
import { resolveInitApps, cwdApp, ensurePluginsJson, registerUpdaterWithApp, type PresentApps } from "./init.js";
import { getAppConfigDir } from "./env.js";
// @ts-ignore — generated bundle, no .d.ts
import { getApps } from "@intisy-ai/core";

const UPDATER_NAME = "plugin-updater";

interface ParsedArgs {
  command: string;
  urls: string[];
  app?: string;
  branch?: string;
  sync?: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { command: argv[0] ?? "", urls: [] };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--app") parsed.app = argv[++i];
    else if (argv[i] === "--branch") parsed.branch = argv[++i];
    else if (argv[i] === "--sync") parsed.sync = true;
    else parsed.urls.push(argv[i]);
  }
  return parsed;
}

function binaryExists(name: string): boolean {
  try {
    const probe = process.platform === "win32" ? `where ${name}` : `command -v ${name}`;
    require("child_process").execSync(probe, { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

// An explicit --app is accepted for the two built-ins OR any app registered in the
// shared app registry (not just claude/opencode) — getConfigDir below then resolves
// it through that same registry.
function detectApp(explicit?: string): string {
  if (explicit === "claude" || explicit === "opencode") return explicit;
  if (explicit) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((getApps() as Array<{ id: string }>).some((a) => a.id === explicit)) return explicit;
    throw new Error(`Unknown app "${explicit}" - use claude, opencode, or a registered app id`);
  }
  const hasClaudeDir = fs.existsSync(path.join(os.homedir(), ".claude"));
  const hasOpencodeDir = fs.existsSync(path.join(os.homedir(), ".opencode"))
    || fs.existsSync(path.join(os.homedir(), ".config", "opencode"));
  if (hasClaudeDir !== hasOpencodeDir) return hasClaudeDir ? "claude" : "opencode";
  const hasClaudeBin = binaryExists("claude");
  const hasOpencodeBin = binaryExists("opencode");
  if (hasClaudeBin !== hasOpencodeBin) return hasClaudeBin ? "claude" : "opencode";
  throw new Error("Both apps (or neither) found - pass --app claude or --app opencode");
}

// Delegates to env.ts's getAppConfigDir, which resolves through the shared app
// registry first (any custom app, once registered) before falling back to the
// two built-in layouts — avoiding a second hardcoded copy of that resolution here.
function getConfigDir(app: string): string {
  return getAppConfigDir(app);
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\s*\/\/[^\n]*/gm, ""));
  } catch {
    return null;
  }
}

function pluginsJsonPath(configDir: string): string {
  return path.join(configDir, "config", "plugins.json");
}

// which apps are installed on this machine (used when no --app is given)
function presentApps(): PresentApps {
  const claude = fs.existsSync(path.join(os.homedir(), ".claude")) || binaryExists("claude");
  const opencode = fs.existsSync(path.join(os.homedir(), ".opencode"))
    || fs.existsSync(path.join(os.homedir(), ".config", "opencode"))
    || binaryExists("opencode");
  return { claude, opencode };
}

// A plain one-line prompt (NOT a menu/TUI) shown when both/neither app is detected and no
// --app was passed: the user just types which app to install for. defaultApp (cwd-inferred)
// may be null — then an empty answer re-asks rather than guessing. Non-interactive callers
// never reach this (resolveInitApps hard-errors instead).
async function promptInitApps(_present: PresentApps, defaultApp: string | null): Promise<string[]> {
  const readline = await import("readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const hint = defaultApp ? `claude/opencode/both, default ${defaultApp}` : "claude/opencode/both";
    for (;;) {
      const ans = (await rl.question(`Install plugin-updater for which app? (${hint}): `)).trim().toLowerCase();
      if (ans === "claude" || ans === "c") return ["claude"];
      if (ans === "opencode" || ans === "o") return ["opencode"];
      if (ans === "both" || ans === "b") return ["opencode", "claude"];
      if (ans === "") {
        if (defaultApp === "both") return ["opencode", "claude"];
        if (defaultApp) return [defaultApp];
      }
      console.log('Please type "claude", "opencode", or "both".');
    }
  } finally {
    rl.close();
  }
}

function addPluginEntry(configDir: string, url: string, branch?: string, sync?: boolean): { name: string; url: string; branch?: string } {
  const cleanUrl = url.replace(/\.git$/, "");
  const name = cleanUrl.split("/").pop() ?? cleanUrl;
  ensurePluginsJson(configDir);
  const file = pluginsJsonPath(configDir);
  const entries = (readJson(file) as unknown as Array<Record<string, unknown>>) ?? [];
  if (!entries.some((e) => e.name === name)) {
    const entry: Record<string, unknown> = { name, url: cleanUrl, enabled: true, autoUpdate: true };
    if (branch) entry.branch = branch;
    if (sync) entry.sync = true;
    entries.push(entry);
    fs.writeFileSync(file, JSON.stringify(entries, null, 2), "utf8");
    console.log(`Added ${name} to ${file}`);
  } else if (sync) {
    // already present: honor --sync by enabling sync on the existing entry
    const existing = entries.find((e) => e.name === name);
    if (existing && existing.sync !== true) {
      existing.sync = true;
      fs.writeFileSync(file, JSON.stringify(entries, null, 2), "utf8");
      console.log(`Enabled sync on ${name} in ${file}`);
    } else {
      console.log(`${name} already present (sync on) in ${file}`);
    }
  } else {
    console.log(`${name} already present in ${file}`);
  }
  return { name, url: cleanUrl, branch };
}

function removePluginEntry(configDir: string, name: string): void {
  const file = pluginsJsonPath(configDir);
  const entries = (readJson(file) as unknown as Array<Record<string, unknown>>) ?? [];
  fs.writeFileSync(file, JSON.stringify(entries.filter((e) => e.name !== name), null, 2), "utf8");
}

async function setupEntry(
  updater: { updatePluginPublic: (name: string, url: string, branch?: string) => Promise<unknown> },
  configDir: string,
  url: string,
  branch?: string,
  sync?: boolean
): Promise<void> {
  const entry = addPluginEntry(configDir, url, branch, sync);
  console.log(`Setting up ${entry.name}...`);
  try {
    await updater.updatePluginPublic(entry.name, entry.url, entry.branch);
  } catch (e) {
    removePluginEntry(configDir, entry.name);
    throw e;
  }
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (!["init", "add", "run", "remove"].includes(parsed.command)) {
    console.log("usage: plugin-updater <init|add|remove|run> [git-urls-or-names...] [--app claude|opencode] [--branch name] [--sync]");
    process.exit(parsed.command ? 1 : 0);
  }

  const updater = await import("./index.js");

  // `init` may target one or both apps: explicit --app wins; otherwise a single
  // detected app is used, and an ambiguous (both/neither) interactive run is prompted.
  if (parsed.command === "init") {
    const apps = await resolveInitApps(parsed.app, {
      present: presentApps,
      isTTY: Boolean(process.stdin.isTTY),
      cwdApp,
      prompt: promptInitApps,
    });
    for (const app of apps) {
      process.env.PLUGIN_UPDATER_APP = app;
      const configDir = getConfigDir(app);
      if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
      console.log(`App: ${app} (${configDir})`);
      const registration = registerUpdaterWithApp(configDir, app);
      console.log(registration.changed
        ? `Registered ${UPDATER_NAME} in ${registration.target}`
        : `${UPDATER_NAME} already registered in ${registration.target}`);
      for (const url of parsed.urls) {
        await setupEntry(updater, configDir, url, parsed.branch, parsed.sync);
      }
    }
    console.log("Init complete.");
    return;
  }

  const app = detectApp(parsed.app);
  process.env.PLUGIN_UPDATER_APP = app;
  const configDir = getConfigDir(app);
  if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
  console.log(`App: ${app} (${configDir})`);

  if (parsed.command === "add") {
    if (parsed.urls.length === 0) throw new Error("add requires at least one git url");
    for (const url of parsed.urls) {
      await setupEntry(updater, configDir, url, parsed.branch, parsed.sync);
    }
  } else if (parsed.command === "remove") {
    if (parsed.urls.length === 0) throw new Error("remove requires at least one plugin name");
    for (const arg of parsed.urls) {
      const name = arg.replace(/\.git$/, "").split("/").pop() ?? arg;
      removePluginEntry(configDir, name);
      try { fs.rmSync(path.join(configDir, "repos", name), { recursive: true, force: true }); } catch { /* ignore */ }
      try { fs.rmSync(path.join(configDir, "plugin", `${name}.js`), { force: true }); } catch { /* ignore */ }
      console.log(`Removed ${name}`);
    }
  } else {
    const entries = (readJson(pluginsJsonPath(configDir)) as unknown as Array<Record<string, unknown>>) ?? [];
    // the CLI is how a loader asks for a run; the app path is activate() at module load
    await updater.earlyLaunch(configDir, entries as never, { trigger: "loader" });
  }
}

// Explicitly exit once the run completes. Dynamically-imported plugin/loader
// modules (deploy.ts) can leave the event loop non-empty (e.g. keepalive refs),
// which would otherwise hang this task-runner and stall CC's SessionStart hook.
// Detached daemons are already unref'd, so they survive the parent exiting.
main()
  .then(() => process.exit(0))
  .catch((e: unknown) => {
    console.error(String((e as { message?: string }).message ?? e));
    process.exit(1);
  });
