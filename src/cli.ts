#!/usr/bin/env node
process.env.PLUGIN_UPDATER_LIBRARY_MODE = "1";
process.env.PLUGIN_UPDATER_CLI = "1";

import fs from "fs";
import path from "path";
import os from "os";
import { resolveOpencodeConfigPath, insertPluginIntoJsonc, resolveInitApps, cwdApp, type PresentApps } from "./init.js";

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
    require("child_process").execSync(probe, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function detectApp(explicit?: string): string {
  if (explicit === "claude" || explicit === "opencode") return explicit;
  if (explicit) throw new Error(`Unknown app "${explicit}" - use claude or opencode`);
  const hasClaudeDir = fs.existsSync(path.join(os.homedir(), ".claude"));
  const hasOpencodeDir = fs.existsSync(path.join(os.homedir(), ".opencode"))
    || fs.existsSync(path.join(os.homedir(), ".config", "opencode"));
  if (hasClaudeDir !== hasOpencodeDir) return hasClaudeDir ? "claude" : "opencode";
  const hasClaudeBin = binaryExists("claude");
  const hasOpencodeBin = binaryExists("opencode");
  if (hasClaudeBin !== hasOpencodeBin) return hasClaudeBin ? "claude" : "opencode";
  throw new Error("Both apps (or neither) found - pass --app claude or --app opencode");
}

function getConfigDir(app: string): string {
  const home = os.homedir();
  const directPath = path.join(home, `.${app}`);
  if (app === "claude") return directPath;
  // opencode's real home is the XDG dir — prefer it whenever it exists (matches
  // the app itself and sync-bridge). A leftover ~/.opencode must never hijack
  // resolution; it's only used when it is the ONLY home present.
  const configPath = path.join(home, ".config", app);
  return fs.existsSync(configPath) || !fs.existsSync(directPath) ? configPath : directPath;
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

function ensurePluginsJson(configDir: string): void {
  const file = pluginsJsonPath(configDir);
  if (!fs.existsSync(path.dirname(file))) fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, "[]\n", "utf8");
}

function registerClaudeHook(configDir: string): void {
  const settingsPath = path.join(configDir, "settings.json");
  const settings = (fs.existsSync(settingsPath) ? readJson(settingsPath) : {}) ?? {};
  const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
  const sessionStart = (hooks.SessionStart ?? []) as unknown[];
  if (!JSON.stringify(sessionStart).includes("plugin-updater")) {
    // @latest so npx re-resolves the tag instead of pinning its first cached copy
    sessionStart.push({ hooks: [{ type: "command", command: "npx -y plugin-updater@latest run --app claude" }] });
  }
  hooks.SessionStart = sessionStart;
  settings.hooks = hooks;
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");
  console.log(`Registered SessionStart hook in ${settingsPath}`);
}

function registerOpencodePlugin(configDir: string): void {
  // Edit the EXISTING opencode config (opencode.json, else opencode.jsonc) rather than
  // always creating opencode.json — opencode reads either and two files are confusing.
  const ocPath = resolveOpencodeConfigPath(configDir);
  const exists = fs.existsSync(ocPath);
  const raw = exists ? fs.readFileSync(ocPath, "utf8") : "";
  const parsed = (exists ? readJson(ocPath) : null) ?? null;
  // opencode plugin entries may be a string OR a [name, options] tuple — guard accordingly
  const plugins = Array.isArray(parsed?.plugin) ? (parsed!.plugin as unknown[]) : [];
  const has = plugins.some((p) =>
    p === "plugin-updater"
    || (typeof p === "string" && p.startsWith("plugin-updater@"))
    || (Array.isArray(p) && p[0] === "plugin-updater"));
  if (has) {
    console.log(`plugin-updater already registered in ${ocPath}`);
    return;
  }
  // Comment-preserving in-place insert for an existing file; fall back to a fresh JSON
  // write only when there's no file or the text can't be safely edited.
  if (exists && raw.trim()) {
    const edited = insertPluginIntoJsonc(raw, "plugin-updater", Array.isArray(parsed?.plugin));
    if (edited) {
      fs.writeFileSync(ocPath, edited, "utf8");
      console.log(`Registered plugin-updater in ${ocPath}`);
      return;
    }
  }
  const oc = (parsed ?? {}) as Record<string, unknown>;
  oc.plugin = ["plugin-updater", ...plugins];
  if (!oc.$schema) oc.$schema = "https://opencode.ai/config.json";
  fs.writeFileSync(ocPath, JSON.stringify(oc, null, 2), "utf8");
  console.log(`Registered plugin-updater in ${ocPath}`);
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
      ensurePluginsJson(configDir);
      if (app === "claude") registerClaudeHook(configDir);
      else registerOpencodePlugin(configDir);
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
    await updater.earlyLaunch(configDir, entries as never);
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
