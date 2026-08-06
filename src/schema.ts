import fs from "fs";
import path from "path";
// @ts-ignore — generated bundle, no .d.ts
import { defineConfig, defineCapabilities, getConfigDefaults, getCapabilities } from "../lib/core.js";

export const UPDATER_NAME = "plugin-updater";

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
  auto_update_triggers: { loader: true, app: true, cairn: true },
};

// Declared at import so anything reaching for the schema (the config CLI, a dashboard
// loading this as a library) sees the same surface, and always before the CLI guard in
// index.ts, which imports this module. Neither call writes a file.
defineConfig(UPDATER_NAME, UPDATER_DEFAULTS);

defineCapabilities(UPDATER_NAME, {
  fields: [
    { key: "logging", type: "boolean", label: "Logging", group: "General" },
    { key: "self_update", type: "boolean", label: "Self-update", description: "Keep plugin-updater itself current.", group: "Updates" },
    { key: "auto_update_mode", type: "select", label: "Automatic updates", group: "Updates",
      description: "off checks nothing on startup, check only records what is available, update also installs it.",
      options: [{ value: "off", label: "off" }, { value: "check", label: "check" }, { value: "update", label: "update" }] },
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
});

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

// The declaration types live in core, which this plugin consumes as an untyped bundle,
// so fields and actions pass through as the data they are; only the menu, which callers
// branch on, is spelled out.
export interface UpdaterSchema {
  plugin: string;
  defaults: Record<string, unknown>;
  current: Record<string, unknown>;
  fields?: Record<string, unknown>[];
  actions?: Record<string, unknown>[];
  menu?: { label: string; glyph?: string; order?: number };
}

// The same shape `node <bundle> config schema` prints, for a caller that holds this
// plugin as a library instead of running its bundle: a home where the updater is
// registered as an npm plugin, or one with nothing deployed yet, has no bundle to probe.
export function updaterSchema(configDir: string): UpdaterSchema {
  return {
    plugin: UPDATER_NAME,
    defaults: getConfigDefaults(UPDATER_NAME),
    current: readUpdaterConfig(configDir),
    ...getCapabilities(UPDATER_NAME),
  };
}
