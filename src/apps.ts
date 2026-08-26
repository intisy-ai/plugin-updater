import os from "os";
// @ts-ignore — generated bundle, no .d.ts
import { getAppDescriptor, resolveHome } from "@intisy-ai/core";
import type { AppDescriptor } from "@intisy-ai/core";

// Looks an app up in the SHARED app registry (libs/core's apps.json, populated by a
// loader's manifest `app` block on install — see index.ts's registerAppFromClone) and
// resolves its home dir the same way core does. Returns null when the app isn't
// registered yet, so callers fall back to their own bootstrap heuristic (there is no
// registry entry to consult before any loader has ever been installed).
export function customAppHome(appName: string, env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string | null {
  const desc = getAppDescriptor(appName, env, home);
  if (!desc) return null;
  return resolveHome(desc, env, home) || null;
}

// The auto-load traits of the two built-in apps, for the bootstrap window in which no loader has
// been installed yet so the registry has no entry to read (the same window getAppConfigDir's
// fallback covers). Data only: the one implementation of both mechanisms lives in core, and a
// registered descriptor always wins over this.
const BOOTSTRAP_AUTO_LOAD: Record<string, Partial<AppDescriptor>> = {
  claude: {
    startupHook: {
      file: "settings.json",
      path: ["hooks", "SessionStart"],
      // @latest so npx re-resolves the tag instead of pinning its first cached copy
      entry: { hooks: [{ type: "command", command: "npx -y {plugin}@latest run --app claude" }] },
    },
  },
  opencode: {
    npmPlugins: {
      configFiles: ["opencode.json", "opencode.jsonc"],
      pluginsKey: "plugin",
      schemaUrl: "https://opencode.ai/config.json",
    },
  },
};

/** How an app auto-loads a plugin: the registry's answer, or the bootstrap one until it has any. */
export function autoLoadDescriptor(appName: string, env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): AppDescriptor | null {
  const registered = getAppDescriptor(appName, env, home) as AppDescriptor | undefined;
  if (registered?.npmPlugins || registered?.startupHook) return registered;
  const fallback = BOOTSTRAP_AUTO_LOAD[appName];
  return fallback ? ({ ...(registered ?? {}), ...fallback } as AppDescriptor) : registered ?? null;
}
