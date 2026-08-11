import { describe, expect, it } from "vitest";
import { resolveChannel, resolveBranch, experimentalBranchName, globalExperimental, tracksExperimental } from "../channel.js";

const OFF = { experimental: false };
const ON = { experimental: true };

describe("resolveChannel", () => {
  it("treats an absent or unrecognized value as inherit", () => {
    expect(resolveChannel(undefined)).toBe("inherit");
    expect(resolveChannel("nonsense")).toBe("inherit");
  });

  it("keeps an explicit choice", () => {
    expect(resolveChannel("stable")).toBe("stable");
    expect(resolveChannel("experimental")).toBe("experimental");
  });
});

describe("experimentalBranchName", () => {
  it("defaults to experimental and honours an override", () => {
    expect(experimentalBranchName({})).toBe("experimental");
    expect(experimentalBranchName({ experimental_branch: "next" })).toBe("next");
  });

  it("ignores a non-string or empty override rather than producing an unusable ref", () => {
    expect(experimentalBranchName({ experimental_branch: "" })).toBe("experimental");
    expect(experimentalBranchName({ experimental_branch: 7 })).toBe("experimental");
  });
});

describe("globalExperimental", () => {
  it("is off unless the home says otherwise", () => {
    expect(globalExperimental({})).toBe(false);
    expect(globalExperimental(ON)).toBe(true);
  });
});

describe("resolveBranch", () => {
  it("returns undefined for a stable plugin, which is the default-branch path", () => {
    expect(resolveBranch({}, OFF, true)).toBeUndefined();
    expect(resolveBranch({ channel: "stable" }, ON, true)).toBeUndefined();
  });

  it("lets an explicit branch win over the channel", () => {
    expect(resolveBranch({ branch: "feat/x", channel: "experimental" }, ON, true)).toBe("feat/x");
    expect(resolveBranch({ branch: "feat/x" }, ON, true)).toBe("feat/x");
  });

  it("uses the experimental branch when the plugin opted in", () => {
    expect(resolveBranch({ channel: "experimental" }, OFF, true)).toBe("experimental");
  });

  it("follows the home's flag when the plugin inherits", () => {
    expect(resolveBranch({}, ON, true)).toBe("experimental");
    expect(resolveBranch({ channel: "inherit" }, ON, true)).toBe("experimental");
    expect(resolveBranch({}, OFF, true)).toBeUndefined();
  });

  it("honours a renamed channel branch", () => {
    expect(resolveBranch({ channel: "experimental" }, { experimental_branch: "next" }, true)).toBe("next");
  });

  // The pair worth asserting separately: collapsing unknown into absent is the easy mistake,
  // and it silently demotes a plugin that is already running the channel.
  it("falls back to stable only when the branch is known to be absent", () => {
    expect(resolveBranch({ channel: "experimental" }, ON, false)).toBeUndefined();
  });

  it("does not fall back when detection is unknown", () => {
    expect(resolveBranch({ channel: "experimental" }, ON, null)).toBe("experimental");
  });

  it("still honours an explicit branch when the channel branch is absent", () => {
    expect(resolveBranch({ branch: "feat/x", channel: "experimental" }, ON, false)).toBe("feat/x");
  });
});

describe("tracksExperimental", () => {
  // The case a control bound to the stored channel gets wrong: inherit under a global yes
  // IS tracking experimental, and must render as such.
  it("is true for an inheriting plugin in a home with the flag on", () => {
    expect(tracksExperimental({}, ON, true)).toBe(true);
    expect(tracksExperimental({ channel: "inherit" }, ON, true)).toBe(true);
  });

  it("is false for a plugin that explicitly opted out of a global yes", () => {
    expect(tracksExperimental({ channel: "stable" }, ON, true)).toBe(false);
  });

  it("is false when an explicit branch takes the plugin somewhere else entirely", () => {
    expect(tracksExperimental({ branch: "feat/x", channel: "experimental" }, ON, true)).toBe(false);
  });

  it("is false when the branch is known to be absent", () => {
    expect(tracksExperimental({ channel: "experimental" }, ON, false)).toBe(false);
  });
});
