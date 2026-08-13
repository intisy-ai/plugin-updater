// A host says "I am importing you as a library" and "I am driving your activation" through env
// keys. Both are read in the generic vocabulary and in the vendor-named one a host deployed
// before it still sets, so neither side of an update can start a second update sequence.
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { isHostActivation, isLibraryMode, setHostActivation } from "../env.js";

const KEYS = ["INTISY_PLUGIN_LIBRARY_MODE", "PLUGIN_UPDATER_LIBRARY_MODE", "INTISY_PLUGIN_ACTIVATION", "PLUGIN_UPDATER_ACTIVATION"];
const saved: Record<string, string | undefined> = {};

describe("the host signals", () => {
  beforeEach(() => {
    for (const key of KEYS) { saved[key] = process.env[key]; delete process.env[key]; }
  });
  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key] as string;
    }
  });

  it("reads library mode from the generic key", () => {
    process.env.INTISY_PLUGIN_LIBRARY_MODE = "1";
    expect(isLibraryMode()).toBe(true);
  });

  it("still reads library mode from a host that only knows the older key", () => {
    process.env.PLUGIN_UPDATER_LIBRARY_MODE = "1";
    expect(isLibraryMode()).toBe(true);
  });

  it("is off when neither key is set", () => {
    expect(isLibraryMode()).toBe(false);
    expect(isHostActivation()).toBe(false);
  });

  it("announces an activation under both keys, so a host of either age sees it", () => {
    setHostActivation(true);
    expect(process.env.INTISY_PLUGIN_ACTIVATION).toBe("1");
    expect(process.env.PLUGIN_UPDATER_ACTIVATION).toBe("1");
    expect(isHostActivation()).toBe(true);
  });

  it("clears both when the activation ends", () => {
    setHostActivation(true);
    setHostActivation(false);
    expect(process.env.INTISY_PLUGIN_ACTIVATION).toBeUndefined();
    expect(process.env.PLUGIN_UPDATER_ACTIVATION).toBeUndefined();
    expect(isHostActivation()).toBe(false);
  });
});
