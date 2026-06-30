// Init-time helpers split out of cli.ts so the comment-preserving opencode-config
// edit and the app-resolution logic are unit-testable without running the CLI entry.
import fs from "fs";
import path from "path";

// ── opencode config target ───────────────────────────────────────────────────
// `init` must NOT create a fresh opencode.json when the user already has an
// opencode.jsonc — opencode reads either, and a second file is confusing. Prefer an
// existing opencode.json, else an existing opencode.jsonc, else default to .json.
export function resolveOpencodeConfigPath(
  configDir: string,
  exists: (p: string) => boolean = fs.existsSync,
): string {
  const jsonPath = path.join(configDir, "opencode.json");
  const jsoncPath = path.join(configDir, "opencode.jsonc");
  if (exists(jsonPath)) return jsonPath;
  if (exists(jsoncPath)) return jsoncPath;
  return jsonPath;
}

// Insert `pluginName` as the first entry of the root `plugin` array, editing the raw
// text in place so // comments and formatting elsewhere survive (a JSON.stringify
// rewrite would strip them). `hasPluginKey` (from the PARSED root, so it can't be
// fooled by a nested "plugin" key or one inside a string) selects the branch: true →
// insert into the existing array; false → add a new `plugin` key. Returns the edited
// text, or null if it can't be safely edited (caller then falls back to a JSON write).
export function insertPluginIntoJsonc(raw: string, pluginName: string, hasPluginKey: boolean): string | null {
  const entry = JSON.stringify(pluginName);

  if (hasPluginKey) {
    // Insert right after the root array's `[`. Prefer a line-anchored match so a deeper
    // `"plugin": [` earlier in the file can't be picked; fall back to the first match.
    const m = raw.match(/^[ \t]*"plugin"\s*:\s*\[/m) ?? raw.match(/"plugin"\s*:\s*\[/);
    if (!m || m.index === undefined) return null;
    const at = m.index + m[0].length;
    const rest = raw.slice(at);
    const isEmpty = /^\s*\]/.test(rest);
    return raw.slice(0, at) + (isEmpty ? entry : `${entry}, `) + rest;
  }

  // No `plugin` key — insert one right after the root `{`.
  const brace = raw.indexOf("{");
  if (brace === -1) return null;
  const afterBrace = raw.slice(brace + 1);
  const isEmptyObject = /^\s*}/.test(afterBrace);
  if (isEmptyObject) {
    return raw.slice(0, brace + 1) + `\n  "plugin": [${entry}]\n` + afterBrace;
  }
  return raw.slice(0, brace + 1) + `\n  "plugin": [${entry}],` + afterBrace;
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
