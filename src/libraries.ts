import fs from "node:fs";
import path from "node:path";
import { getReposDir } from "./env.js";
import { declaredLibraries, sharedStoreDir } from "./shared-libs.js";

// One resolvable package on disk, whether it came from the shared store or a plugin's
// own npm install. `usedBy` is only meaningful for shared libraries: it names the plugins
// that declare the library, which is what makes a version worth keeping.
export interface InstalledLibrary {
  specifier: string;
  version: string;
  usedBy: string[];
}

export interface PluginDependencies {
  plugin: string;
  dependencies: InstalledLibrary[];
}

export interface HomeLibraries {
  shared: InstalledLibrary[];
  plugins: PluginDependencies[];
}

function readPackage(dir: string): { name?: string; version?: string; dependencies?: Record<string, string> } | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { name?: string; version?: string };
  } catch {
    return null;
  }
}

function directories(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

// A node_modules directory holds packages at the top level and scoped ones a level
// deeper, so a scope directory is descended into rather than reported as a package.
function packageDirs(storeDir: string): string[] {
  const found: string[] = [];
  for (const entry of directories(storeDir)) {
    if (entry === ".bin") continue;
    const dir = path.join(storeDir, entry);
    if (entry.startsWith("@")) {
      for (const scoped of directories(dir)) found.push(path.join(dir, scoped));
    } else {
      found.push(dir);
    }
  }
  return found;
}

function readLibrary(dir: string, usedBy: string[] = []): InstalledLibrary | null {
  const pkg = readPackage(dir);
  if (!pkg || typeof pkg.name !== "string" || pkg.name.length === 0) return null;
  return { specifier: pkg.name, version: typeof pkg.version === "string" ? pkg.version : "", usedBy };
}

function byName(a: InstalledLibrary, b: InstalledLibrary): number {
  return a.specifier.localeCompare(b.specifier);
}

// Which plugins declare each shared library, taken from the clones' own submodules so it
// stays true for a library added by nothing more than a submodule.
function declarersBySpecifier(reposDir: string): Map<string, string[]> {
  const declarers = new Map<string, string[]>();
  for (const plugin of directories(reposDir)) {
    for (const library of declaredLibraries(path.join(reposDir, plugin))) {
      const existing = declarers.get(library.specifier);
      if (existing) existing.push(plugin);
      else declarers.set(library.specifier, [plugin]);
    }
  }
  return declarers;
}

export function sharedLibraries(configDir: string): InstalledLibrary[] {
  const declarers = declarersBySpecifier(getReposDir(configDir));
  return packageDirs(sharedStoreDir(configDir))
    .map((dir) => readLibrary(dir))
    .filter((library): library is InstalledLibrary => library !== null)
    .map((library) => ({ ...library, usedBy: (declarers.get(library.specifier) ?? []).sort() }))
    .sort(byName);
}

// A plugin's own dependencies, reported at the version actually installed next to it
// rather than the range its package.json asks for. A declared dependency that never got
// installed is still listed, with an empty version, because its absence is the
// interesting part.
export function pluginDependencies(configDir: string, plugin: string): InstalledLibrary[] {
  const cloneDir = path.join(getReposDir(configDir), plugin);
  const declared = readPackage(cloneDir)?.dependencies;
  if (!declared) return [];
  const store = path.join(cloneDir, "node_modules");
  return Object.keys(declared)
    .map((name) => readLibrary(path.join(store, ...name.split("/"))) ?? { specifier: name, version: "", usedBy: [] })
    .sort(byName);
}

export function homeLibraries(configDir: string): HomeLibraries {
  const reposDir = getReposDir(configDir);
  const plugins = directories(reposDir)
    .map((plugin) => ({ plugin, dependencies: pluginDependencies(configDir, plugin) }))
    .filter((entry) => entry.dependencies.length > 0)
    .sort((a, b) => a.plugin.localeCompare(b.plugin));
  return { shared: sharedLibraries(configDir), plugins };
}
