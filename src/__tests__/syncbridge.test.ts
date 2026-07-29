import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { syncAllAcrossApps, readSyncStatus } from "../syncbridge.js";

function fakeBridge(marker: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pu-sb-"));
  const libDir = join(dir, "repos", "sync-bridge", "dist");
  mkdirSync(libDir, { recursive: true });
  writeFileSync(
    join(libDir, "lib.js"),
    `import { writeFileSync } from "fs";\n` +
      `export function syncAll() { writeFileSync(${JSON.stringify(marker)}, "ran"); return { enabled: true }; }\n` +
      `export function syncStatus() { return { enabled: true, homes: ["a", "b"] }; }\n`,
  );
  return dir;
}

describe("plugin-updater syncbridge wrapper", () => {
  it("syncAllAcrossApps loads sync-bridge and calls syncAll", async () => {
    const marker = join(mkdtempSync(join(tmpdir(), "pu-mark-")), "ran.txt");
    const configDir = fakeBridge(marker);
    await syncAllAcrossApps(configDir);
    expect(existsSync(marker)).toBe(true);
  });

  it("readSyncStatus returns the bridge status", async () => {
    const configDir = fakeBridge(join(tmpdir(), "unused-marker"));
    const status = (await readSyncStatus(configDir)) as { enabled: boolean; homes: string[] } | null;
    expect(status?.enabled).toBe(true);
    expect(status?.homes).toEqual(["a", "b"]);
  });

  it("syncAllAcrossApps is a no-op when sync-bridge is not installed", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "pu-empty-"));
    await expect(syncAllAcrossApps(configDir)).resolves.toBeUndefined();
    expect(await readSyncStatus(configDir)).toBeNull();
  });
});
