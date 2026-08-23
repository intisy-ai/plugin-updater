import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { libraryManagement, pluginManagement, registerPluginEntry, removePluginEntry } from "../manage.js";

describe("registerPluginEntry", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "pu-manage-")); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  function entries(): Array<Record<string, unknown>> {
    return JSON.parse(readFileSync(join(home, "config", "plugins.json"), "utf8"));
  }

  it("derives the entry name from the repository url", () => {
    const added = registerPluginEntry(home, "https://github.com/intisy-ai/demo-plugin.git");
    expect(added).toMatchObject({ name: "demo-plugin", url: "https://github.com/intisy-ai/demo-plugin", added: true, changed: true });
    expect(entries()).toEqual([
      { name: "demo-plugin", url: "https://github.com/intisy-ai/demo-plugin", enabled: true, autoUpdate: true },
    ]);
  });

  it("reports an entry that is already listed rather than duplicating it", () => {
    registerPluginEntry(home, "https://github.com/intisy-ai/demo-plugin");
    const again = registerPluginEntry(home, "https://github.com/intisy-ai/demo-plugin");
    expect(again.added).toBe(false);
    expect(again.changed).toBe(false);
    expect(entries()).toHaveLength(1);
  });

  it("turns sync on for an entry that is already listed without it", () => {
    registerPluginEntry(home, "https://github.com/intisy-ai/demo-plugin");
    const again = registerPluginEntry(home, "https://github.com/intisy-ai/demo-plugin", { sync: true });
    expect(again).toMatchObject({ added: false, syncEnabled: true, changed: true });
    expect(entries()[0].sync).toBe(true);
  });

  it("reports no change for an entry whose sync is already on, so a caller cannot claim it acted", () => {
    registerPluginEntry(home, "https://github.com/intisy-ai/demo-plugin", { sync: true });
    const again = registerPluginEntry(home, "https://github.com/intisy-ai/demo-plugin", { sync: true });
    expect(again).toMatchObject({ added: false, syncEnabled: true, changed: false });
  });

  it("carries a branch onto a new entry", () => {
    registerPluginEntry(home, "https://github.com/intisy-ai/demo-plugin", { branch: "experimental" });
    expect(entries()[0].branch).toBe("experimental");
  });

  it("removes an entry by name and leaves the others", () => {
    registerPluginEntry(home, "https://github.com/intisy-ai/one");
    registerPluginEntry(home, "https://github.com/intisy-ai/two");
    removePluginEntry(home, "one");
    expect(entries().map((entry) => entry.name)).toEqual(["two"]);
  });
});

describe("the plugin-management capability", () => {
  let home: string;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "pu-cap-"));
    for (const key of ["HUB_CONFIG_DIR", "PLUGIN_UPDATER_APP"]) saved[key] = process.env[key];
    process.env.HUB_CONFIG_DIR = home;
    process.env.PLUGIN_UPDATER_APP = "opencode";
  });
  afterEach(() => {
    for (const key of ["HUB_CONFIG_DIR", "PLUGIN_UPDATER_APP"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key] as string;
    }
    rmSync(home, { recursive: true, force: true });
  });

  function listed(entries: unknown): void {
    mkdirSync(join(home, "config"), { recursive: true });
    writeFileSync(join(home, "config", "plugins.json"), JSON.stringify(entries));
  }

  const noOutcome = { updated: [], skipped: [], failed: [], checkedAt: "" };

  function capability(overrides: Record<string, unknown> = {}) {
    const calls: unknown[][] = [];
    const capability = pluginManagement(home, {
      updatePluginPublic: async (...args: unknown[]) => { calls.push(["update", ...args]); },
      uninstallPlugin: (...args: unknown[]) => { calls.push(["uninstall", ...args]); },
      updateOne: async (...args: unknown[]) => { calls.push(["updateOne", ...args]); return noOutcome; },
      updateAll: async (...args: unknown[]) => { calls.push(["updateAll", ...args]); return noOutcome; },
      downgrade: (...args: unknown[]) => { calls.push(["downgrade", ...args]); return "moved to abc123"; },
      pluginChannelState: () => ({ onExperimental: false, experimentalAvailable: null }),
      ...overrides,
    } as never);
    return { capability, calls };
  }

  it("lists what the home has registered, treating an absent enabled key as enabled", async () => {
    listed([
      { name: "on", url: "https://github.com/intisy-ai/on" },
      { name: "off", url: "https://github.com/intisy-ai/off", enabled: false },
    ]);
    expect(await capability().capability.list()).toEqual([
      { id: "on", enabled: true, url: "https://github.com/intisy-ai/on", version: "" },
      { id: "off", enabled: false, url: "https://github.com/intisy-ai/off", version: "" },
    ]);
  });

  it("installs by registering the entry first, then setting it up", async () => {
    listed([]);
    const { capability: managed, calls } = capability();
    const result = await managed.install("https://github.com/intisy-ai/demo-plugin.git");
    expect(result.ok).toBe(true);
    expect(calls).toEqual([["update", "demo-plugin", "https://github.com/intisy-ai/demo-plugin", undefined]]);
    expect(JSON.parse(readFileSync(join(home, "config", "plugins.json"), "utf8"))[0].name).toBe("demo-plugin");
  });

  it("un-registers an entry whose setup failed, so a name nothing installed is not left listed", async () => {
    listed([]);
    const { capability: managed } = capability({
      updatePluginPublic: async () => { throw new Error("clone refused"); },
    });
    const result = await managed.install("https://github.com/intisy-ai/demo-plugin");
    expect(result).toMatchObject({ ok: false, message: "clone refused" });
    expect(JSON.parse(readFileSync(join(home, "config", "plugins.json"), "utf8"))).toEqual([]);
  });

  it("reports a failed removal as a result rather than throwing at the host", async () => {
    listed([]);
    const { capability: managed } = capability({
      uninstallPlugin: () => { throw new Error("plugin not found: absent"); },
    });
    const result = await managed.remove("absent");
    expect(result).toMatchObject({ ok: false, message: "plugin not found: absent" });
  });

  // The entry module's WRAPPED updateOne is what registers the app a clone carries; routing an
  // update at the raw runner in updates.ts would install without it, which no host could see.
  it("updates through the entry module's wrapped runner, not the raw one", async () => {
    listed([{ name: "demo", url: "https://github.com/intisy-ai/demo" }]);
    const { capability: managed, calls } = capability();
    expect(await managed.update("demo")).toMatchObject({ ok: true });
    expect(calls).toEqual([["updateOne", home, "demo"]]);
  });

  it("names every plugin that failed a full update run", async () => {
    listed([]);
    const { capability: managed } = capability({
      updateAll: async () => ({ updated: ["one"], skipped: [], failed: ["two", "three"], checkedAt: "" }),
    });
    expect(await managed.updateAll()).toMatchObject({ ok: false, message: "failed to update two, three" });
  });

  it("reports nothing to do as a success, so a host does not show a failure for a current home", async () => {
    listed([]);
    expect(await capability().capability.updateAll()).toMatchObject({ ok: true, message: "everything is current" });
  });

  it("writes an enabled flag and says what it did", async () => {
    listed([{ name: "demo", url: "https://github.com/intisy-ai/demo" }]);
    expect(await capability().capability.setEnabled("demo", false)).toMatchObject({ ok: true, message: "demo disabled" });
    expect(JSON.parse(readFileSync(join(home, "config", "plugins.json"), "utf8"))[0].enabled).toBe(false);
  });

  // The underlying setter answers with a bare false for both "no such plugin" and "no list at all",
  // so the capability has to turn that into a result a host can show rather than a silent no-op.
  it("declines a setting for a plugin the home does not list", async () => {
    listed([]);
    const { capability: managed } = capability();
    expect(await managed.setEnabled("absent", true)).toMatchObject({ ok: false, message: "no plugin absent in this home" });
    expect(await managed.setAutoUpdate("absent", true)).toMatchObject({ ok: false });
    expect(await managed.setChannel("absent", "experimental")).toMatchObject({ ok: false });
  });

  it("records a channel change against the entry", async () => {
    listed([{ name: "demo", url: "https://github.com/intisy-ai/demo" }]);
    expect(await capability().capability.setChannel("demo", "experimental")).toMatchObject({ ok: true, message: "demo tracks experimental" });
    expect(JSON.parse(readFileSync(join(home, "config", "plugins.json"), "utf8"))[0].channel).toBe("experimental");
  });

  it("downgrades the entry the home lists, and declines one it does not", async () => {
    listed([{ name: "demo", url: "https://github.com/intisy-ai/demo" }]);
    const { capability: managed, calls } = capability();
    expect(await managed.downgrade("demo", "abc123")).toMatchObject({ ok: true, message: "moved to abc123" });
    expect(calls[0][0]).toBe("downgrade");
    expect((calls[0][1] as { name: string }).name).toBe("demo");
    expect(await managed.downgrade("absent", "abc123")).toMatchObject({ ok: false, message: "no plugin absent in this home" });
  });

  it("reads back the cache without going upstream", async () => {
    listed([]);
    const { getCachePath } = await import("../cache.js");
    const file = getCachePath(home);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, JSON.stringify({ checkedAt: "2026-08-23T00:00:00.000Z", plugins: { demo: { kind: "git", updateAvailable: true } } }));
    expect(await capability().capability.updateCache()).toMatchObject({ checkedAt: "2026-08-23T00:00:00.000Z" });
  });

  it("leaves the ambient home exactly as it found it", async () => {
    listed([]);
    const { getEarlyLaunchConfigDir } = await import("../env.js");
    const before = getEarlyLaunchConfigDir();
    await capability().capability.list();
    expect(getEarlyLaunchConfigDir()).toBe(before);
  });

  describe("the entry module's default export", () => {
    it("is a plugin the host can load, and provides what the manifest declares", async () => {
      const provided: string[] = [];
      const plugin = (await import("../index.js")).default;
      expect(typeof plugin.activate).toBe("function");
      expect(typeof plugin.deactivate).toBe("function");
      await plugin.activate({
        paths: { home: process.env.HUB_CONFIG_DIR as string },
        provide: (key: string | { id: string }) => { provided.push(typeof key === "string" ? key : key.id); },
      } as never);
      expect(provided).toEqual(["plugin-management", "library-management"]);
    });

    // A host quarantines a provide the manifest never declared, so the two lists drifting apart
    // costs the capability at run time while every unit test here still passes.
    it("provides exactly what its manifest declares", async () => {
      const provided: string[] = [];
      const plugin = (await import("../index.js")).default;
      await plugin.activate({
        paths: { home: process.env.HUB_CONFIG_DIR as string },
        provide: (key: string | { id: string }) => { provided.push(typeof key === "string" ? key : key.id); },
      } as never);
      const manifest = JSON.parse(readFileSync(new URL("../../plugin.json", import.meta.url), "utf8"));
      expect(provided.slice().sort()).toEqual(manifest.capabilities.slice().sort());
    });
  });
});

// homeLibraries and removeLibrary are covered against their own fixtures in libraries.test.ts and
// removeLibrary.test.ts; what is worth asserting here is that the capability reaches the home it was
// resolved against, because that is the only thing the per-home handle adds.
describe("the library-management capability", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "pu-libcap-")); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  function installLibrary(specifier: string, version: string): void {
    const dir = join(home, "node_modules", ...specifier.split("/"));
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: specifier, version, main: "dist/index.js" }));
    writeFileSync(join(dir, "dist", "index.js"), "");
  }

  function declare(plugin: string, submodule: string, packageName: string): void {
    const dir = join(home, "repos", plugin);
    mkdirSync(join(dir, submodule), { recursive: true });
    writeFileSync(join(dir, ".gitmodules"), `[submodule "${submodule}"]
	path = ${submodule}
	url = https://example/${submodule}
`);
    writeFileSync(join(dir, submodule, "package.json"), JSON.stringify({ name: packageName }));
  }

  it("lists the libraries of the home it was resolved against", async () => {
    installLibrary("@intisy-ai/core", "1.2.3");
    declare("demo", "core", "@intisy-ai/core");
    const answer = await libraryManagement(home).libraries();
    expect(answer.shared).toEqual([{ specifier: "@intisy-ai/core", version: "1.2.3", usedBy: ["demo"] }]);
  });

  it("declines a removal while a plugin still declares it", async () => {
    installLibrary("@intisy-ai/core", "1.2.3");
    declare("demo", "core", "@intisy-ai/core");
    expect(await libraryManagement(home).remove("@intisy-ai/core")).toEqual({ removed: false, usedBy: ["demo"] });
  });
});
