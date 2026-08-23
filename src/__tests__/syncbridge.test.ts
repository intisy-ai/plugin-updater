import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { syncAllAcrossApps, readSyncStatus } from "../syncbridge.js";
import { getPluginDir } from "../env.js";

const SAVED: Record<string, string | undefined> = {};
const KEYS = ["HUB_CONFIG_DIR", "PLUGIN_UPDATER_APP"];

afterEach(() => {
  for (const key of KEYS) {
    if (SAVED[key] === undefined) delete process.env[key];
    else process.env[key] = SAVED[key] as string;
  }
});

function home(): string {
  for (const key of KEYS) SAVED[key] = process.env[key];
  const dir = mkdtempSync(join(tmpdir(), "pu-sb-"));
  process.env.HUB_CONFIG_DIR = dir;
  process.env.PLUGIN_UPDATER_APP = "opencode";
  return dir;
}

// A plugin deployed the way this repo deploys one: a bundle plus the manifest sidecar beside it
// that says which capabilities it provides. The provider is named "bridge" rather than
// "sync-bridge" on purpose, because nothing in the resolution may depend on the name.
function deployProvider(configDir: string, capabilities: string[], body: string): void {
  const dir = getPluginDir(configDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "bridge.json"), JSON.stringify({ id: "bridge", api: 1, entry: "bridge.js", capabilities }));
  writeFileSync(join(dir, "bridge.js"), body);
}

function providerBody(marker: string): string {
  return [
    "export default {",
    "  activate(context) {",
    "    context.provide({ id: 'cross-app-sync' }, {",
    "      sync: async () => {",
    "        const { writeFileSync } = await import('fs');",
    `        writeFileSync(${JSON.stringify(marker)}, 'ran');`,
    "        return { files: ['config/settings.json'], plugins: [], homes: ['a', 'b'] };",
    "      },",
    "    });",
    "  },",
    "  deactivate() {},",
    "};",
  ].join("\n");
}

describe("cross-app sync from a launch sequence", () => {
  it("resolves the provider by capability and runs its sync", async () => {
    const configDir = home();
    const marker = join(mkdtempSync(join(tmpdir(), "pu-mark-")), "ran.txt");
    deployProvider(configDir, ["cross-app-sync"], providerBody(marker));

    await syncAllAcrossApps(configDir);

    expect(existsSync(marker)).toBe(true);
  });

  // The ordinary first-run case, and the one an install depends on: a home with no provider must
  // cost the sync, never the launch.
  it("is a silent no-op when nothing in the home provides it", async () => {
    const configDir = home();
    await expect(syncAllAcrossApps(configDir)).resolves.toBeUndefined();
  });

  it("ignores a deployed plugin that provides something else", async () => {
    const configDir = home();
    const marker = join(mkdtempSync(join(tmpdir(), "pu-mark-")), "never.txt");
    deployProvider(configDir, ["screens"], providerBody(marker));

    await syncAllAcrossApps(configDir);

    expect(existsSync(marker)).toBe(false);
  });

  // A provider that throws is still a launch that has to finish.
  it("survives a provider whose sync throws", async () => {
    const configDir = home();
    deployProvider(configDir, ["cross-app-sync"], [
      "export default {",
      "  activate(context) {",
      "    context.provide({ id: 'cross-app-sync' }, { sync: async () => { throw new Error('boom'); } });",
      "  },",
      "  deactivate() {},",
      "};",
    ].join("\n"));

    await expect(syncAllAcrossApps(configDir)).resolves.toBeUndefined();
  });
});

describe("readSyncStatus", () => {
  it("answers null when no bridge library is cloned in the home", async () => {
    const configDir = home();
    expect(await readSyncStatus(configDir)).toBeNull();
  });
});
