// Which branch a plugin tracks, resolved from its own entry and its home's config. Pure,
// so every rule is checkable without a home on disk: the callers do the I/O.
import type { Plugin } from "./types.js";

export type PluginChannel = "inherit" | "stable" | "experimental";

const DEFAULT_EXPERIMENTAL_BRANCH = "experimental";

export function resolveChannel(raw: unknown): PluginChannel {
  if (raw === "stable" || raw === "experimental" || raw === "inherit") return raw;
  return "inherit";
}

export function experimentalBranchName(cfg: Record<string, unknown>): string {
  const raw = cfg?.experimental_branch;
  return typeof raw === "string" && raw.length > 0 ? raw : DEFAULT_EXPERIMENTAL_BRANCH;
}

export function globalExperimental(cfg: Record<string, unknown>): boolean {
  return cfg?.experimental === true;
}

// `detected` is three-state on purpose. Only a definite false blocks the channel: an
// unanswered detection must not demote a plugin that is already running it.
export function resolveBranch(
  plugin: Pick<Plugin, "branch" | "channel">,
  cfg: Record<string, unknown>,
  detected: boolean | null,
): string | undefined {
  if (plugin.branch) return plugin.branch;
  const channel = resolveChannel(plugin.channel);
  const wanted = channel === "experimental" || (channel === "inherit" && globalExperimental(cfg));
  if (!wanted || detected === false) return undefined;
  return experimentalBranchName(cfg);
}

// What a control binds to and a row reports. An explicit `branch` is neither channel, so it
// reads as false: the plugin is somewhere the toggle cannot describe.
export function tracksExperimental(
  plugin: Pick<Plugin, "branch" | "channel">,
  cfg: Record<string, unknown>,
  detected: boolean | null,
): boolean {
  if (plugin.branch) return false;
  return resolveBranch(plugin, cfg, detected) !== undefined;
}
