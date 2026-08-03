import os from "os";
// @ts-ignore — generated bundle, no .d.ts
import { getAppDescriptor, resolveHome } from "../lib/core.js";

// Looks an app up in the SHARED app registry (libs/core's apps.json, populated by a
// loader's cairn.json `app` block on install — see index.ts's registerAppFromClone) and
// resolves its home dir the same way core does. Returns null when the app isn't
// registered yet, so callers fall back to their own bootstrap heuristic (there is no
// registry entry to consult before any loader has ever been installed).
export function customAppHome(appName: string, env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string | null {
  const desc = getAppDescriptor(appName, env, home);
  if (!desc) return null;
  return resolveHome(desc, env, home) || null;
}
