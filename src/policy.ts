// What a home wants done about updates, resolved from its own config. Pure, so every
// rule is checkable without a home on disk: the callers do the I/O.

export type UpdateMode = "off" | "check" | "update";
export type Trigger = "loader" | "app" | "cairn";
export type PluginAutoUpdate = "inherit" | "on" | "off";

const MODES: string[] = ["off", "check", "update"];

export function resolveMode(cfg: Record<string, unknown>): UpdateMode {
  const raw = cfg?.auto_update_mode;
  if (typeof raw === "string" && MODES.includes(raw)) return raw as UpdateMode;
  // the flag this key replaces: it only ever meant "pull on launch, or do not"
  if (cfg?.update_on_launch === false) return "check";
  return "update";
}

export function triggerEnabled(cfg: Record<string, unknown>, trigger: Trigger): boolean {
  const triggers = cfg?.auto_update_triggers;
  if (!triggers || typeof triggers !== "object" || Array.isArray(triggers)) return true;
  return (triggers as Record<string, unknown>)[trigger] !== false;
}

export function resolvePluginAutoUpdate(raw: unknown): PluginAutoUpdate {
  if (raw === "on" || raw === "off" || raw === "inherit") return raw;
  if (raw === false) return "off";
  return "inherit";
}

// A plugin that opted in updates even in a home that only checks; a plugin that opted
// out never updates. Everything else follows the home.
export function shouldPull(cfg: Record<string, unknown>, rawPluginFlag: unknown): boolean {
  const plugin = resolvePluginAutoUpdate(rawPluginFlag);
  if (plugin === "off") return false;
  if (plugin === "on") return true;
  return resolveMode(cfg) === "update";
}
