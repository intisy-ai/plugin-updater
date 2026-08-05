// @ts-ignore: generated bundle, no .d.ts
import { emitEvent, TOPICS, setActivityContext, getActivityContext, resetActivityContext } from "../lib/core.js";
import { getAppConfigDir, getAppName } from "./env.js";

// Announce a plugin's install/update/failure on the event bus so a dashboard can
// observe plugin management without polling. Best-effort (emitEvent never throws).
export type ActivityTrigger = "launch" | "manual";

// core resolves an event's home from its own env-based view, which is NOT this run's
// target when a host drives us in-process for another app's home (a dashboard managing
// several apps). This module already knows the dir every path operates on, so it states
// it per emit and restores the previous context, because a sticky home would send the
// next caller's events to this one's home.
function emit(spec: Record<string, unknown>, home?: string): void {
  const previous = getActivityContext();
  try {
    setActivityContext({ home: home || getAppConfigDir(getAppName()) });
  } catch { /* fall back to whatever core resolves */ }
  try {
    emitEvent(spec, "plugin-updater");
  } finally {
    try { resetActivityContext(); setActivityContext(previous); } catch { /* best effort */ }
  }
}

export function pluginSubject(name: string): { kind: "plugin"; id: string; label: string } {
  return { kind: "plugin", id: name, label: name };
}

// A plugin nobody instrumented still gets a lifecycle event, because this runs for
// every plugin on every app start. The cause is stated rather than inherited so it
// stays "startup" even when a caller wraps the sequence in a scope of its own.
export function emitPluginActivated(name: string, details: Record<string, unknown> = {}): void {
  emit({
    topic: TOPICS.pluginActivated,
    action: "activated",
    impact: "info",
    actor: "app",
    cause: { kind: "startup" },
    subject: pluginSubject(name),
    details,
  });
}

export function emitPluginInstalled(name: string, version: string | null, trigger: ActivityTrigger): void {
  emit({
    topic: TOPICS.pluginInstalled,
    action: "installed",
    impact: "notice",
    outcome: "ok",
    subject: pluginSubject(name),
    details: { version: version || "", trigger },
  });
}

export function emitPluginUpdated(name: string, fromVersion: string | null, toVersion: string | null, trigger: ActivityTrigger): void {
  emit({
    topic: TOPICS.pluginInstalled,
    action: "updated",
    impact: "notice",
    outcome: "ok",
    subject: pluginSubject(name),
    details: { fromVersion, toVersion: toVersion || "", trigger },
  });
}

export function emitPluginUpdateAvailable(name: string, fromVersion: string | null, toVersion: string | null): void {
  emit({
    topic: TOPICS.pluginInstalled,
    action: "update_available",
    impact: "info",
    outcome: "ok",
    subject: pluginSubject(name),
    details: { fromVersion, toVersion },
  });
}

export function emitPluginUpdateFailed(name: string, err: unknown): void {
  emit({
    topic: TOPICS.pluginInstalled,
    action: "update_failed",
    impact: "error",
    outcome: "failed",
    subject: pluginSubject(name),
    details: { message: String((err as { message?: string })?.message ?? err) },
  });
}

export function emitPluginUninstalled(name: string, details: Record<string, unknown> = {}, home?: string): void {
  emit({
    topic: TOPICS.pluginInstalled,
    action: "uninstalled",
    impact: "notice",
    outcome: "ok",
    subject: pluginSubject(name),
    details,
  }, home);
}

export function emitPluginDowngraded(name: string, hash: string, home?: string): void {
  emit({
    topic: TOPICS.pluginInstalled,
    action: "downgraded",
    impact: "notice",
    outcome: "ok",
    subject: pluginSubject(name),
    details: { hash },
  }, home);
}

// Work in flight, not a fact worth keeping: recorded at debug so it stays out of a
// reader's way unless the home's floor is deliberately lowered. Nothing consumes it.
export function emitPluginProgress(name: string, phase: string): void {
  emit({
    topic: TOPICS.pluginProgress,
    action: phase,
    impact: "debug",
    actor: "app",
    subject: pluginSubject(name),
    details: { name, phase },
  });
}
