// @ts-ignore: generated bundle, no .d.ts
import { emitEvent, TOPICS } from "../lib/core.js";

// Announce a plugin's install/update/failure on the event bus so a dashboard can
// observe plugin management without polling. Best-effort (emitEvent never throws).
export type ActivityTrigger = "launch" | "manual";

export function pluginSubject(name: string): { kind: "plugin"; id: string; label: string } {
  return { kind: "plugin", id: name, label: name };
}

// A plugin nobody instrumented still gets a lifecycle event, because this runs for
// every plugin on every app start. The cause is stated rather than inherited so it
// stays "startup" even when a caller wraps the sequence in a scope of its own.
export function emitPluginActivated(name: string, details: Record<string, unknown> = {}): void {
  emitEvent({
    topic: TOPICS.pluginActivated,
    action: "activated",
    impact: "info",
    actor: "app",
    cause: { kind: "startup" },
    subject: pluginSubject(name),
    details,
  }, "plugin-updater");
}

export function emitPluginInstalled(name: string, version: string | null, trigger: ActivityTrigger): void {
  emitEvent({
    topic: TOPICS.pluginInstalled,
    action: "installed",
    impact: "notice",
    outcome: "ok",
    subject: pluginSubject(name),
    details: { version: version || "", trigger },
  }, "plugin-updater");
}

export function emitPluginUpdated(name: string, fromVersion: string | null, toVersion: string | null, trigger: ActivityTrigger): void {
  emitEvent({
    topic: TOPICS.pluginInstalled,
    action: "updated",
    impact: "notice",
    outcome: "ok",
    subject: pluginSubject(name),
    details: { fromVersion, toVersion: toVersion || "", trigger },
  }, "plugin-updater");
}

export function emitPluginUpdateAvailable(name: string, fromVersion: string | null, toVersion: string | null): void {
  emitEvent({
    topic: TOPICS.pluginInstalled,
    action: "update_available",
    impact: "info",
    outcome: "ok",
    subject: pluginSubject(name),
    details: { fromVersion, toVersion },
  }, "plugin-updater");
}

export function emitPluginUpdateFailed(name: string, err: unknown): void {
  emitEvent({
    topic: TOPICS.pluginInstalled,
    action: "update_failed",
    impact: "error",
    outcome: "failed",
    subject: pluginSubject(name),
    details: { message: String((err as { message?: string })?.message ?? err) },
  }, "plugin-updater");
}

export function emitPluginUninstalled(name: string): void {
  emitEvent({
    topic: TOPICS.pluginInstalled,
    action: "uninstalled",
    impact: "notice",
    outcome: "ok",
    subject: pluginSubject(name),
    details: {},
  }, "plugin-updater");
}

export function emitPluginDowngraded(name: string, hash: string): void {
  emitEvent({
    topic: TOPICS.pluginInstalled,
    action: "downgraded",
    impact: "notice",
    outcome: "ok",
    subject: pluginSubject(name),
    details: { hash },
  }, "plugin-updater");
}
