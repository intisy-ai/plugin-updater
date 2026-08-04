// @ts-ignore: generated bundle, no .d.ts
import { emitEvent, TOPICS } from "../lib/core.js";

// Announce a plugin's install/update/failure on the event bus so a dashboard can
// observe plugin management without polling. Best-effort (emitEvent never throws).
export type ActivityTrigger = "launch" | "manual";

export function pluginSubject(name: string): { kind: "plugin"; id: string; label: string } {
  return { kind: "plugin", id: name, label: name };
}

export function emitPluginInstalled(name: string, version: string | null, trigger: ActivityTrigger): void {
  emitEvent({
    topic: TOPICS.pluginInstalled,
    action: "installed",
    impact: "notice",
    subject: pluginSubject(name),
    details: { version: version || "", trigger },
  }, "plugin-updater");
}

export function emitPluginUpdated(name: string, fromVersion: string | null, toVersion: string | null, trigger: ActivityTrigger): void {
  emitEvent({
    topic: TOPICS.pluginInstalled,
    action: "updated",
    impact: "notice",
    subject: pluginSubject(name),
    details: { fromVersion, toVersion: toVersion || "", trigger },
  }, "plugin-updater");
}

export function emitPluginUpdateAvailable(name: string, fromVersion: string | null, toVersion: string | null): void {
  emitEvent({
    topic: TOPICS.pluginInstalled,
    action: "update_available",
    impact: "info",
    subject: pluginSubject(name),
    details: { fromVersion, toVersion },
  }, "plugin-updater");
}

export function emitPluginUpdateFailed(name: string, err: unknown): void {
  emitEvent({
    topic: TOPICS.pluginInstalled,
    action: "update_failed",
    impact: "error",
    subject: pluginSubject(name),
    details: { message: String((err as { message?: string })?.message ?? err) },
  }, "plugin-updater");
}
