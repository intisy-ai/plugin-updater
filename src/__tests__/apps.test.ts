import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getAppConfigDir, getAppName } from "../env.js";

function tempHome() { return mkdtempSync(join(tmpdir(), "pu-apps-")); }

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
});
