import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getAppConfigDir, getAppName } from "../env.js";
import { customAppHome } from "../apps.js";
// @ts-ignore — generated bundle, no .d.ts
import { registerApp, resolveHome, getAppDescriptor } from "@intisy-ai/basekit";

function tempHome() { return mkdtempSync(join(tmpdir(), "pu-apps-")); }

// Snapshot/restore every env var the registry-driven resolution chain consults, so a
// test that registers real app descriptors can't leak env state into later tests.
const REGISTRY_ENV_KEYS = [
  "HOME", "USERPROFILE", "HUB_CONFIG_DIR", "HUB_APPS_FILE",
  "HUB_CLAUDE_DIR", "CLAUDE_CONFIG_DIR", "HUB_OPENCODE_DIR", "OPENCODE_CONFIG_DIR", "XDG_CONFIG_HOME",
] as const;
function snapshotEnv(): Record<string, string | undefined> {
  const snap: Record<string, string | undefined> = {};
  for (const key of REGISTRY_ENV_KEYS) snap[key] = process.env[key];
  return snap;
}
function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const key of REGISTRY_ENV_KEYS) {
    if (snap[key] === undefined) delete process.env[key];
    else process.env[key] = snap[key];
  }
}

describe("plugin-updater app resolution", () => {
  it("resolves a built-in app home exactly as before (claude -> ~/.claude)", () => {
    const home = tempHome();
    const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, HUB_CONFIG_DIR: process.env.HUB_CONFIG_DIR, HUB_APPS_FILE: process.env.HUB_APPS_FILE };
    process.env.HOME = home; process.env.USERPROFILE = home;
    delete process.env.HUB_CONFIG_DIR; process.env.HUB_APPS_FILE = join(home, "apps.json");
    try {
      expect(getAppConfigDir("claude")).toBe(join(home, ".claude"));
    } finally {
      Object.assign(process.env, prev);
      if (prev.HUB_CONFIG_DIR === undefined) delete process.env.HUB_CONFIG_DIR;
      if (prev.HUB_APPS_FILE === undefined) delete process.env.HUB_APPS_FILE;
    }
  });

  it("resolves a custom app home from apps.json via the mirror", () => {
    const home = tempHome();
    const acmeHome = join(home, ".acme"); mkdirSync(acmeHome);
    writeFileSync(join(home, "apps.json"), JSON.stringify({
      acme: { id: "acme", label: "Acme", home: { candidates: [acmeHome] },
        detect: { binary: "acme", pkg: "acme-cli" }, commandsSubdir: "commands",
        proxyPort: 0, integration: "env-baseurl", wireFormat: "anthropic", builtin: false },
    }));
    const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, HUB_CONFIG_DIR: process.env.HUB_CONFIG_DIR, HUB_APPS_FILE: process.env.HUB_APPS_FILE };
    process.env.HOME = home; process.env.USERPROFILE = home;
    delete process.env.HUB_CONFIG_DIR; process.env.HUB_APPS_FILE = join(home, "apps.json");
    try {
      expect(getAppConfigDir("acme")).toBe(acmeHome);
    } finally {
      Object.assign(process.env, prev);
      if (prev.HUB_CONFIG_DIR === undefined) delete process.env.HUB_CONFIG_DIR;
      if (prev.HUB_APPS_FILE === undefined) delete process.env.HUB_APPS_FILE;
    }
  });

  it("resolves a custom app home from its registered envOverride, which the naive ~/.<appName> fallback could never produce", () => {
    const home = tempHome();
    const overrideHome = join(home, "somewhere-else", "acme-data"); mkdirSync(overrideHome, { recursive: true });
    const fallbackCandidate = join(home, ".acme");
    writeFileSync(join(home, "apps.json"), JSON.stringify({
      acme: { id: "acme", label: "Acme", home: { envOverride: "ACME_HOME", candidates: [fallbackCandidate] },
        detect: { binary: "acme", pkg: "acme-cli" }, commandsSubdir: "commands",
        proxyPort: 0, integration: "env-baseurl", wireFormat: "anthropic", builtin: false },
    }));
    const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, HUB_CONFIG_DIR: process.env.HUB_CONFIG_DIR, HUB_APPS_FILE: process.env.HUB_APPS_FILE, ACME_HOME: process.env.ACME_HOME };
    process.env.HOME = home; process.env.USERPROFILE = home;
    delete process.env.HUB_CONFIG_DIR; process.env.HUB_APPS_FILE = join(home, "apps.json");
    process.env.ACME_HOME = overrideHome;
    try {
      expect(getAppConfigDir("acme")).toBe(overrideHome);
      expect(getAppConfigDir("acme")).not.toBe(fallbackCandidate);
    } finally {
      Object.assign(process.env, prev);
      if (prev.HUB_CONFIG_DIR === undefined) delete process.env.HUB_CONFIG_DIR;
      if (prev.HUB_APPS_FILE === undefined) delete process.env.HUB_APPS_FILE;
      if (prev.ACME_HOME === undefined) delete process.env.ACME_HOME;
    }
  });

  it("resolves both built-in apps from the registry once they're registered (normal case: config dir exists)", () => {
    const home = tempHome();
    const claudeHome = join(home, ".claude");
    const opencodeHome = join(home, ".config", "opencode");
    mkdirSync(claudeHome, { recursive: true });
    mkdirSync(opencodeHome, { recursive: true });

    const prev = snapshotEnv();
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    delete process.env.HUB_CONFIG_DIR;
    process.env.HUB_APPS_FILE = join(home, "apps.json");
    // Unset every override/native/xdg signal the descriptors below declare, so
    // resolution falls through to the candidate list (the normal case being tested)
    // instead of short-circuiting on an env var.
    delete process.env.HUB_CLAUDE_DIR;
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.HUB_OPENCODE_DIR;
    delete process.env.OPENCODE_CONFIG_DIR;
    delete process.env.XDG_CONFIG_HOME;

    try {
      // Mirrors the real loader manifests (claude-code-loader / opencode-loader
      // cairn.json `app` blocks) so this exercises the same descriptor shape a real
      // install would register, not a synthetic minimal one.
      registerApp({
        id: "claude", label: "Claude Code",
        home: { envOverride: "HUB_CLAUDE_DIR", nativeEnv: "CLAUDE_CONFIG_DIR", candidates: ["~/.claude", "~/.config/claude"] },
        detect: { binary: "claude", pkg: "@anthropic-ai/claude-code" },
        commandsSubdir: "commands", proxyPort: 34567, integration: "env-baseurl", wireFormat: "anthropic",
      });
      registerApp({
        id: "opencode", label: "OpenCode",
        home: { envOverride: "HUB_OPENCODE_DIR", nativeEnv: "OPENCODE_CONFIG_DIR", xdgSubdir: "opencode", candidates: ["~/.config/opencode", "~/.opencode"] },
        detect: { binary: "opencode", pkg: "opencode-ai" },
        commandsSubdir: "command", proxyPort: 34568, integration: "native", wireFormat: "anthropic",
      });

      // customAppHome + getAppConfigDir go through plugin-updater's own resolution chain
      expect(customAppHome("claude")).toBe(claudeHome);
      expect(customAppHome("opencode")).toBe(opencodeHome);
      expect(getAppConfigDir("claude")).toBe(claudeHome);
      expect(getAppConfigDir("opencode")).toBe(opencodeHome);

      // resolveHome directly against the registered descriptors: proves the registry
      // entry itself (not just plugin-updater's wrapper) resolves to the real homes.
      const claudeDesc = getAppDescriptor("claude");
      const opencodeDesc = getAppDescriptor("opencode");
      expect(claudeDesc).toBeTruthy();
      expect(opencodeDesc).toBeTruthy();
      expect(resolveHome(claudeDesc)).toBe(claudeHome);
      expect(resolveHome(opencodeDesc)).toBe(opencodeHome);
    } finally {
      restoreEnv(prev);
    }
  });
});
