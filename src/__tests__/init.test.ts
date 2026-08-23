import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { resolveInitApps, cwdApp, registerUpdaterWithApp, ensurePluginsJson } from "../init.js";

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pu-init-"));
}

describe("cwdApp", () => {
  it("returns opencode in the opencode config dir", () => {
    expect(cwdApp("/root/.config/opencode")).toBe("opencode");
    expect(cwdApp("/home/me/.opencode")).toBe("opencode");
  });
  it("returns claude in the claude config dir", () => {
    expect(cwdApp("/root/.claude")).toBe("claude");
  });
  it("returns null outside a config dir (e.g. /workspace)", () => {
    expect(cwdApp("/workspace")).toBeNull();
    expect(cwdApp("/projects/my-opencode-plugin")).toBeNull(); // substring must not match
  });
});

describe("resolveInitApps", () => {
  const baseDeps = {
    isTTY: true,
    cwdApp: () => "opencode",
    prompt: async () => ["opencode"],
  };

  it("honors an explicit app", async () => {
    expect(await resolveInitApps("claude", { ...baseDeps, present: () => ({ claude: true, opencode: true }) })).toEqual(["claude"]);
  });

  it("rejects an unknown explicit app", async () => {
    await expect(resolveInitApps("bogus", { ...baseDeps, present: () => ({ claude: false, opencode: false }) })).rejects.toThrow(/Unknown app/);
  });

  it("uses the single detected app without prompting", async () => {
    let prompted = false;
    const apps = await resolveInitApps(undefined, { ...baseDeps, present: () => ({ claude: false, opencode: true }), prompt: async () => { prompted = true; return ["claude"]; } });
    expect(apps).toEqual(["opencode"]);
    expect(prompted).toBe(false);
  });

  it("prompts when both are detected and interactive", async () => {
    const apps = await resolveInitApps(undefined, { ...baseDeps, present: () => ({ claude: true, opencode: true }), prompt: async (_p, def) => [def ?? "none"] });
    expect(apps).toEqual(["opencode"]); // cwd default
  });

  it("defaults to 'both' when cwd gives no signal", async () => {
    let seenDefault: string | null = "unset";
    const apps = await resolveInitApps(undefined, {
      ...baseDeps,
      cwdApp: () => null,
      present: () => ({ claude: true, opencode: true }),
      prompt: async (_p, def) => { seenDefault = def; return def === "both" ? ["opencode", "claude"] : [def ?? "none"]; },
    });
    expect(seenDefault).toBe("both");
    expect(apps).toEqual(["opencode", "claude"]);
  });

  it("can return both apps from the prompt", async () => {
    const apps = await resolveInitApps(undefined, { ...baseDeps, present: () => ({ claude: true, opencode: true }), prompt: async () => ["opencode", "claude"] });
    expect(apps).toEqual(["opencode", "claude"]);
  });

  it("throws (no guessing) when ambiguous and non-interactive", async () => {
    await expect(resolveInitApps(undefined, { ...baseDeps, isTTY: false, present: () => ({ claude: true, opencode: true }) })).rejects.toThrow(/pass --app/);
  });
});

describe("ensurePluginsJson", () => {
  it("creates an empty plugins.json under config/", () => {
    const dir = tempHome();
    ensurePluginsJson(dir);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "config", "plugins.json"), "utf8"))).toEqual([]);
  });

  it("leaves an existing plugins.json untouched", () => {
    const dir = tempHome();
    const file = path.join(dir, "config", "plugins.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify([{ name: "keep" }]), "utf8");
    ensurePluginsJson(dir);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual([{ name: "keep" }]);
  });
});

describe("registerUpdaterWithApp", () => {
  it("registers a SessionStart hook for a hook-style app", () => {
    const dir = tempHome();
    const result = registerUpdaterWithApp(dir, "claude");
    expect(result.changed).toBe(true);
    expect(result.target).toBe(path.join(dir, "settings.json"));
    const settings = JSON.parse(fs.readFileSync(result.target, "utf8"));
    expect(JSON.stringify(settings.hooks.SessionStart)).toContain("plugin-updater");
  });

  it("registers the plugin entry for an opencode-style app", () => {
    const dir = tempHome();
    const result = registerUpdaterWithApp(dir, "opencode");
    expect(result.changed).toBe(true);
    expect(JSON.parse(fs.readFileSync(result.target, "utf8")).plugin).toContain("plugin-updater");
  });

  it("is idempotent and reports no change on a second run", () => {
    for (const app of ["claude", "opencode"]) {
      const dir = tempHome();
      const first = registerUpdaterWithApp(dir, app);
      const before = fs.readFileSync(first.target, "utf8");
      const second = registerUpdaterWithApp(dir, app);
      expect(second.changed).toBe(false);
      expect(fs.readFileSync(second.target, "utf8")).toBe(before);
    }
  });

  it("creates plugins.json for either app style", () => {
    for (const app of ["claude", "opencode"]) {
      const dir = tempHome();
      registerUpdaterWithApp(dir, app);
      expect(fs.existsSync(path.join(dir, "config", "plugins.json"))).toBe(true);
    }
  });

  it("preserves comments in an existing opencode.jsonc", () => {
    const dir = tempHome();
    fs.writeFileSync(path.join(dir, "opencode.jsonc"), '{\n  // keep me\n  "plugin": ["foo"]\n}', "utf8");
    const result = registerUpdaterWithApp(dir, "opencode");
    const raw = fs.readFileSync(result.target, "utf8");
    expect(raw).toContain("// keep me");
    expect(raw).toContain("plugin-updater");
  });

  it("keeps an existing hook and reports no change when the updater is already registered", () => {
    const dir = tempHome();
    const settings = path.join(dir, "settings.json");
    fs.writeFileSync(settings, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "npx -y plugin-updater@latest run --app claude" }] }] } }), "utf8");
    const result = registerUpdaterWithApp(dir, "claude");
    expect(result.changed).toBe(false);
    expect(JSON.parse(fs.readFileSync(settings, "utf8")).hooks.SessionStart).toHaveLength(1);
  });
});
