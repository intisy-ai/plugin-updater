import { describe, it, expect } from "vitest";
import { resolveOpencodeConfigPath, insertPluginIntoJsonc, resolveInitApps, cwdApp } from "../init.js";

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

describe("resolveOpencodeConfigPath", () => {
  it("prefers an existing opencode.json", () => {
    const has = (p: string) => p.endsWith("opencode.json") || p.endsWith("opencode.jsonc");
    expect(resolveOpencodeConfigPath("/cfg", has).endsWith("opencode.json")).toBe(true);
  });
  it("uses opencode.jsonc when only it exists", () => {
    const has = (p: string) => p.endsWith("opencode.jsonc");
    expect(resolveOpencodeConfigPath("/cfg", has).endsWith("opencode.jsonc")).toBe(true);
  });
  it("defaults to opencode.json when neither exists", () => {
    expect(resolveOpencodeConfigPath("/cfg", () => false).endsWith("opencode.json")).toBe(true);
  });
});

describe("insertPluginIntoJsonc", () => {
  const PLUG = "plugin-updater";

  it("inserts into an empty plugin array", () => {
    const out = insertPluginIntoJsonc('{\n  "plugin": []\n}', PLUG, true)!;
    expect(out).toContain('"plugin": ["plugin-updater"]');
    expect(JSON.parse(out).plugin).toEqual(["plugin-updater"]);
  });

  it("prepends to a non-empty plugin array and keeps existing entries", () => {
    const out = insertPluginIntoJsonc('{\n  "plugin": ["foo"]\n}', PLUG, true)!;
    expect(JSON.parse(out).plugin).toEqual(["plugin-updater", "foo"]);
  });

  it("keeps a [name, options] tuple entry intact", () => {
    const raw = '{\n  "plugin": [["@scope/x", { "bankId": "opencode" }]]\n}';
    const out = insertPluginIntoJsonc(raw, PLUG, true)!;
    expect(JSON.parse(out).plugin).toEqual(["plugin-updater", ["@scope/x", { bankId: "opencode" }]]);
  });

  it("adds a plugin key when none exists, preserving other keys", () => {
    const out = insertPluginIntoJsonc('{\n  "$schema": "x"\n}', PLUG, false)!;
    const parsed = JSON.parse(out);
    expect(parsed.plugin).toEqual(["plugin-updater"]);
    expect(parsed.$schema).toBe("x");
  });

  it("handles an empty object without producing a trailing comma", () => {
    const out = insertPluginIntoJsonc("{}", PLUG, false)!;
    expect(JSON.parse(out).plugin).toEqual(["plugin-updater"]);
  });

  it("does not match a nested plugin key when the root has none", () => {
    // root object has no plugin key; a nested one must NOT be edited (hasPluginKey=false)
    const raw = '{\n  "models": { "plugin": ["m"] },\n  "$schema": "x"\n}';
    const out = insertPluginIntoJsonc(raw, PLUG, false)!;
    const parsed = JSON.parse(out);
    expect(parsed.plugin).toEqual(["plugin-updater"]);
    expect(parsed.models.plugin).toEqual(["m"]); // untouched
  });

  it("preserves // comments in the file", () => {
    const raw = '{\n  // keep me\n  "plugin": ["foo"]\n}';
    const out = insertPluginIntoJsonc(raw, PLUG, true)!;
    expect(out).toContain("// keep me");
    // strip comments to validate the JSON shape
    expect(JSON.parse(out.replace(/^\s*\/\/[^\n]*/gm, "")).plugin).toEqual(["plugin-updater", "foo"]);
  });

  it("returns null when the text is not a JSON object", () => {
    expect(insertPluginIntoJsonc("not json", PLUG, false)).toBeNull();
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

  it("passes a null default to the prompt when cwd gives no signal", async () => {
    let seenDefault: string | null = "unset";
    await resolveInitApps(undefined, {
      ...baseDeps,
      cwdApp: () => null,
      present: () => ({ claude: true, opencode: true }),
      prompt: async (_p, def) => { seenDefault = def; return ["claude"]; },
    });
    expect(seenDefault).toBeNull();
  });

  it("can return both apps from the prompt", async () => {
    const apps = await resolveInitApps(undefined, { ...baseDeps, present: () => ({ claude: true, opencode: true }), prompt: async () => ["opencode", "claude"] });
    expect(apps).toEqual(["opencode", "claude"]);
  });

  it("throws (no guessing) when ambiguous and non-interactive", async () => {
    await expect(resolveInitApps(undefined, { ...baseDeps, isTTY: false, present: () => ({ claude: true, opencode: true }) })).rejects.toThrow(/pass --app/);
  });
});
