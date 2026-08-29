import fs from "fs";
import path from "path";
import type { ActionSpec, CapabilitySchema, FieldSpec } from "@intisy-ai/basekit";

export const UPDATER_NAME = "plugin-updater";

/**
 * This plugin's own settings.
 *
 * @remarks
 * Stated here for the code that reads them and in `plugin.json` for the host that registers them
 * without running this plugin. `manifest-defaults.test.ts` is what keeps the two identical.
 */
export const UPDATER_DEFAULTS: Record<string, unknown> = {
  logging: true,
  default_update_interval_hours: 1,
  git_timeout_seconds: 120,
  npm_timeout_seconds: 300,
  build_timeout_seconds: 300,
  daemon_health_timeout_ms: 1500,
  self_update: true,
  update_on_launch: true,
  auto_update_mode: "update",
  experimental: false,
  experimental_branch: "experimental",
  auto_update_triggers: { loader: true, app: true, cairn: true },
};

// What each setting is called and how a surface renders it, beside the values the manifest
// declares. Data the settings capability answers with.
export const UPDATER_SETTINGS: CapabilitySchema = {
  fields: [
    { key: "logging", type: "boolean", label: "Logging", group: "General" },
    { key: "self_update", type: "boolean", label: "Self-update", description: "Keep plugin-updater itself current.", group: "Updates" },
    { key: "auto_update_mode", type: "select", label: "Automatic updates", group: "Updates",
      description: "off checks nothing on startup, check only records what is available, update also installs it.",
      options: [{ value: "off", label: "off" }, { value: "check", label: "check" }, { value: "update", label: "update" }] },
    { key: "experimental", type: "boolean", label: "Experimental builds", group: "Updates",
      description: "Track the pre-release branch for plugins that have not chosen for themselves." },
    { key: "experimental_branch", type: "string", label: "Experimental branch", group: "Updates",
      description: "Which branch the experimental channel means." },
    { key: "auto_update_triggers.loader", type: "boolean", label: "Check when the launcher menu opens", group: "Triggers" },
    { key: "auto_update_triggers.app", type: "boolean", label: "Check when the app starts", group: "Triggers" },
    { key: "auto_update_triggers.cairn", type: "boolean", label: "Check when the dashboard starts", group: "Triggers" },
    { key: "update_on_launch", type: "boolean", label: "Update on launch", group: "Updates" },
    { key: "default_update_interval_hours", type: "number", label: "Update interval (h)", min: 0, group: "Updates" },
    { key: "git_timeout_seconds", type: "number", label: "Git timeout (s)", min: 1, group: "Timeouts" },
    { key: "npm_timeout_seconds", type: "number", label: "npm timeout (s)", min: 1, group: "Timeouts" },
    { key: "build_timeout_seconds", type: "number", label: "Build timeout (s)", min: 1, group: "Timeouts" },
    { key: "daemon_health_timeout_ms", type: "number", label: "Daemon health timeout (ms)", min: 0, group: "Timeouts" },
  ],
};

// Config as it is on disk NOW. core's loadConfig caches per home for the life of the
// process (including the absence of a file, which is what a plugin sees when it loads
// before a home is configured), so a mode changed by a dashboard or by hand would
// otherwise not apply until every process restarted.
export function readUpdaterConfig(configDir: string): Record<string, unknown> {
  for (const file of [path.join(configDir, "config", `${UPDATER_NAME}.json`), path.join(configDir, `${UPDATER_NAME}.json`)]) {
    try {
      if (!fs.existsSync(file)) continue;
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch { /* an unreadable config means defaults, never a crash */ }
  }
  return {};
}

export interface UpdaterSchema {
  plugin: string;
  defaults: Record<string, unknown>;
  current: Record<string, unknown>;
  fields?: FieldSpec[];
  actions?: ActionSpec[];
}

// The same shape `node <bundle> config schema` prints, for a caller that holds this
// plugin as a library instead of running its bundle: a home where the updater is
// registered as an npm plugin, or one with nothing deployed yet, has no bundle to probe.
export function updaterSchema(configDir: string): UpdaterSchema {
  return {
    plugin: UPDATER_NAME,
    defaults: UPDATER_DEFAULTS,
    current: readUpdaterConfig(configDir),
    ...UPDATER_SETTINGS,
  };
}
