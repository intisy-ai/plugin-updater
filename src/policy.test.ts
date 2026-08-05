import { describe, it, expect } from "vitest";
import { resolveMode, triggerEnabled, resolvePluginAutoUpdate, shouldPull } from "./policy.js";

describe("update mode", () => {
  it("defaults to updating, so a home with no settings behaves as it always has", () => {
    expect(resolveMode({})).toBe("update");
  });

  it("takes the three modes verbatim and ignores anything else", () => {
    expect(resolveMode({ auto_update_mode: "off" })).toBe("off");
    expect(resolveMode({ auto_update_mode: "check" })).toBe("check");
    expect(resolveMode({ auto_update_mode: "update" })).toBe("update");
    expect(resolveMode({ auto_update_mode: "sometimes" })).toBe("update");
  });

  it("honours the older update_on_launch flag when no mode is set", () => {
    expect(resolveMode({ update_on_launch: false })).toBe("check");
    expect(resolveMode({ update_on_launch: true })).toBe("update");
    expect(resolveMode({ update_on_launch: false, auto_update_mode: "update" })).toBe("update");
  });
});

describe("triggers", () => {
  it("enables every trigger by default", () => {
    for (const trigger of ["loader", "app", "cairn"] as const) {
      expect(triggerEnabled({}, trigger)).toBe(true);
    }
  });

  it("disables only what the home turned off", () => {
    const cfg = { auto_update_triggers: { cairn: false } };
    expect(triggerEnabled(cfg, "cairn")).toBe(false);
    expect(triggerEnabled(cfg, "loader")).toBe(true);
  });

  it("ignores a triggers value that is not an object", () => {
    expect(triggerEnabled({ auto_update_triggers: "yes" }, "loader")).toBe(true);
  });
});

describe("per-plugin tri-state", () => {
  it("reads the three states and treats the old booleans as inherit and off", () => {
    expect(resolvePluginAutoUpdate("on")).toBe("on");
    expect(resolvePluginAutoUpdate("off")).toBe("off");
    expect(resolvePluginAutoUpdate("inherit")).toBe("inherit");
    expect(resolvePluginAutoUpdate(true)).toBe("inherit");
    expect(resolvePluginAutoUpdate(false)).toBe("off");
    expect(resolvePluginAutoUpdate(undefined)).toBe("inherit");
    expect(resolvePluginAutoUpdate("nonsense")).toBe("inherit");
  });
});

describe("whether a plugin gets pulled", () => {
  it("pulls when the home updates and the plugin inherits", () => {
    expect(shouldPull({ auto_update_mode: "update" }, undefined)).toBe(true);
    expect(shouldPull({ auto_update_mode: "update" }, "inherit")).toBe(true);
    expect(shouldPull({ auto_update_mode: "update" }, true)).toBe(true);
  });

  it("never pulls a plugin that opted out, whatever the home says", () => {
    expect(shouldPull({ auto_update_mode: "update" }, "off")).toBe(false);
    expect(shouldPull({ auto_update_mode: "update" }, false)).toBe(false);
  });

  it("pulls a plugin that opted in even when the home only checks", () => {
    expect(shouldPull({ auto_update_mode: "check" }, "on")).toBe(true);
    expect(shouldPull({ auto_update_mode: "off" }, "on")).toBe(true);
  });

  it("does not pull an inheriting plugin when the home is not updating", () => {
    expect(shouldPull({ auto_update_mode: "check" }, "inherit")).toBe(false);
    expect(shouldPull({ auto_update_mode: "off" }, undefined)).toBe(false);
  });

  it("follows the older flag when that is all the home has", () => {
    expect(shouldPull({ update_on_launch: false }, undefined)).toBe(false);
    expect(shouldPull({ update_on_launch: true }, undefined)).toBe(true);
  });
});
