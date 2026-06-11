#!/usr/bin/env node
process.env.PLUGIN_UPDATER_LIBRARY_MODE = "1";
process.env.PLUGIN_UPDATER_CLI = "1";

import fs from "fs";
import path from "path";
import os from "os";

interface ParsedArgs {
  command: string;
  urls: string[];
  app?: string;
  branch?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { command: argv[0] ?? "", urls: [] };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--app") parsed.app = argv[++i];
    else if (argv[i] === "--branch") parsed.branch = argv[++i];
    else parsed.urls.push(argv[i]);
  }
  return parsed;
}

function detectApp(explicit?: string): string {
  if (explicit === "claude" || explicit === "opencode") return explicit;
  if (explicit) throw new Error(`Unknown app "${explicit}" - use claude or opencode`);
  const hasClaude = fs.existsSync(path.join(os.homedir(), ".claude"));
  const hasOpencode = fs.existsSync(path.join(os.homedir(), ".opencode"))
    || fs.existsSync(path.join(os.homedir(), ".config", "opencode"));
  if (hasClaude && !hasOpencode) return "claude";
  if (hasOpencode && !hasClaude) return "opencode";
  throw new Error("Cannot detect the app automatically - pass --app claude or --app opencode");
}

function getConfigDir(app: string): string {
  const home = os.homedir();
  const directPath = path.join(home, `.${app}`);
  const configPath = path.join(home, ".config", app);
  return fs.existsSync(directPath) ? directPath : app === "claude" ? directPath : configPath;
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
  if (!JSON.stringify(sessionStart).includes("plugin-updater run")) {
    sessionStart.push({ hooks: [{ type: "command", command: "npx -y plugin-updater run --app claude" }] });
  }
  hooks.SessionStart = sessionStart;
  settings.hooks = hooks;
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");
  console.log(`Registered SessionStart hook in ${settingsPath}`);
}

function registerOpencodePlugin(configDir: string): void {
  const ocPath = path.join(configDir, "opencode.json");
  const oc = (fs.existsSync(ocPath) ? readJson(ocPath) : {}) ?? {};
  const plugins = Array.isArray(oc.plugin) ? (oc.plugin as string[]) : [];
  if (!plugins.some((p) => p === "plugin-updater" || p.startsWith("plugin-updater@"))) {
    plugins.unshift("plugin-updater");
  }
  oc.plugin = plugins;
  if (!oc.$schema) oc.$schema = "https://opencode.ai/config.json";
  fs.writeFileSync(ocPath, JSON.stringify(oc, null, 2), "utf8");
  console.log(`Registered plugin-updater in ${ocPath}`);
}

function addPluginEntry(configDir: string, url: string, branch?: string): { name: string; url: string; branch?: string } {
  const cleanUrl = url.replace(/\.git$/, "");
  const name = cleanUrl.split("/").pop() ?? cleanUrl;
  ensurePluginsJson(configDir);
  const file = pluginsJsonPath(configDir);
  const entries = (readJson(file) as unknown as Array<Record<string, unknown>>) ?? [];
  if (!entries.some((e) => e.name === name)) {
    const entry: Record<string, unknown> = { name, url: cleanUrl, enabled: true, autoUpdate: true };
    if (branch) entry.branch = branch;
    entries.push(entry);
    fs.writeFileSync(file, JSON.stringify(entries, null, 2), "utf8");
    console.log(`Added ${name} to ${file}`);
  } else {
    console.log(`${name} already present in ${file}`);
  }
  return { name, url: cleanUrl, branch };
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (!["init", "add", "run"].includes(parsed.command)) {
    console.log("usage: plugin-updater <init|add|run> [git-urls...] [--app claude|opencode] [--branch name]");
    process.exit(parsed.command ? 1 : 0);
  }

  const app = detectApp(parsed.app);
  process.env.PLUGIN_UPDATER_APP = app;
  const configDir = getConfigDir(app);
  if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
  console.log(`App: ${app} (${configDir})`);

  const updater = await import("./index.js");

  if (parsed.command === "init") {
    ensurePluginsJson(configDir);
    if (app === "claude") registerClaudeHook(configDir);
    else registerOpencodePlugin(configDir);
    for (const url of parsed.urls) {
      const entry = addPluginEntry(configDir, url, parsed.branch);
      console.log(`Setting up ${entry.name}...`);
      await updater.updatePluginPublic(entry.name, entry.url, entry.branch);
    }
    console.log("Init complete.");
  } else if (parsed.command === "add") {
    if (parsed.urls.length === 0) throw new Error("add requires at least one git url");
    for (const url of parsed.urls) {
      const entry = addPluginEntry(configDir, url, parsed.branch);
      console.log(`Setting up ${entry.name}...`);
      await updater.updatePluginPublic(entry.name, entry.url, entry.branch);
    }
  } else {
    const entries = (readJson(pluginsJsonPath(configDir)) as unknown as Array<Record<string, unknown>>) ?? [];
    await updater.earlyLaunch(configDir, entries as never);
  }
}

main().catch((e: unknown) => {
  console.error(String((e as { message?: string }).message ?? e));
  process.exit(1);
});
