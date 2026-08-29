// Init-time helpers split out of cli.ts so app registration and app resolution are
// unit-testable without running the CLI entry.
import fs from "fs";
import path from "path";
// @ts-ignore - generated bundle, no .d.ts
import { registerPluginWithApp } from "@intisy-ai/basekit";
import { autoLoadDescriptor } from "./apps.js";

const UPDATER = "plugin-updater";

export interface UpdaterRegistration {
  target: string;
  changed: boolean;
}

export function ensurePluginsJson(configDir: string): void {
  const file = path.join(configDir, "config", "plugins.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, "[]\n", "utf8");
}

/**
 * Makes `app` load the updater on its own next start, and gives it a plugin registry to read.
 *
 * @remarks
 * Needed by the CLI's `init` and by a host installing the updater in-process, so it lives here
 * rather than in the CLI entry. Nothing prints: a host embedding this must not write to its
 * stdout. An app declaring no way to auto-load a plugin registers nothing, which is not a failure.
 */
export function registerUpdaterWithApp(configDir: string, app: string): UpdaterRegistration {
  ensurePluginsJson(configDir);
  return registerPluginWithApp(configDir, autoLoadDescriptor(app), UPDATER) ?? { target: "", changed: false };
}


// ── app resolution ───────────────────────────────────────────────────────────
export interface PresentApps {
  claude: boolean;
  opencode: boolean;
}

// Infer the app ONLY from the current directory actually being an app's config dir
// (~/.claude or ~/.config/opencode|~/.opencode). Returns null otherwise — e.g. /workspace
// — so the prompt offers no default rather than silently assuming opencode.
export function cwdApp(cwd: string = process.cwd()): string | null {
  const c = cwd.replace(/\\/g, "/");
  if (/(^|\/)\.claude(\/|$)/.test(c)) return "claude";
  if (/(^|\/)\.opencode(\/|$)/.test(c) || /(^|\/)\.config\/opencode(\/|$)/.test(c)) return "opencode";
  return null;
}

export interface InitAppDeps {
  present: () => PresentApps;                 // which apps are installed/detected
  isTTY: boolean;                             // are we interactive (can we prompt)?
  cwdApp: () => string | null;                // app inferred from the current dir, or null
  prompt: (present: PresentApps, defaultApp: string | null) => Promise<string[]>;
}

// Decide which app(s) `init` targets. Explicit --app always wins. A single detected
// app is used directly. When both or neither are detected we PROMPT (if interactive)
// so the user can pick one or both; non-interactively we keep the hard error rather
// than guess. The prompt default is the cwd-inferred app when the cwd is a config dir,
// otherwise "both" (a neutral dir like /workspace defaults to setting up both apps).
export async function resolveInitApps(explicit: string | undefined, deps: InitAppDeps): Promise<string[]> {
  if (explicit === "claude" || explicit === "opencode") return [explicit];
  if (explicit) throw new Error(`Unknown app "${explicit}" - use claude or opencode`);

  const p = deps.present();
  if (p.claude !== p.opencode) return [p.claude ? "claude" : "opencode"];

  if (!deps.isTTY) {
    throw new Error("Both apps (or neither) found - pass --app claude or --app opencode");
  }
  return deps.prompt(p, deps.cwdApp() ?? "both");
}
