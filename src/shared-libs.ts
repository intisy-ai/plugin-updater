import fs from "node:fs";
import path from "node:path";
// @ts-ignore - generated bundle, no .d.ts
import { submodulePaths, submoduleTree } from "@intisy-ai/core";

// A library a plugin carries as a submodule and no longer inlines. The specifier
// is what the plugin's built bundle imports; the store is where Node finds it.
export interface SharedLibrary {
  dir: string;
  specifier: string;
}

const SCOPE = "@intisy-ai";

// The store sits at the HOME's root rather than inside the deployed-plugin directory:
// Node resolves a bare specifier by walking up from the importing file, and two
// consumers import from different depths. The deployed bundle sits at
// <home>/plugin/<name>.js, while a provider's handler is loaded straight out of its
// clone at <home>/repos/<name>/dist/. Only the home root is above both.
export function sharedStoreDir(configDir: string): string {
  return path.join(configDir, "node_modules");
}

// A submodule without a usable package.json is skipped rather than guessed at, since its
// specifier would be a fabrication.
function librariesAt(sourceDir: string, relativePaths: string[]): SharedLibrary[] {
  const libraries: SharedLibrary[] = [];
  for (const relative of relativePaths) {
    const dir = path.join(sourceDir, relative);
    let name: unknown;
    try {
      name = (JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { name?: unknown }).name;
    } catch {
      continue;
    }
    if (typeof name !== "string" || name.length === 0) continue;
    libraries.push({ dir, specifier: name.startsWith("@") ? name : `${SCOPE}/${name}` });
  }
  return libraries;
}

// The library set comes from the clone's own .gitmodules and each submodule's
// package name, never from a list here: adding a library is then a submodule and
// nothing else. These are what the clone ships, so they are what gets materialized.
export function declaredLibraries(sourceDir: string): SharedLibrary[] {
  return librariesAt(sourceDir, submodulePaths(sourceDir));
}

// The same set widened to the whole submodule tree. Asking "does anything still declare this
// library" has to see the nested ones too (core-proxy nests core-ir), or a store entry a
// plugin genuinely depends on is credited to nobody and reads as left over.
export function declaredLibraryTree(sourceDir: string): SharedLibrary[] {
  return librariesAt(sourceDir, submoduleTree(sourceDir));
}

// What a home's store must hold for this clone to resolve its imports: the whole tree, not only
// the top level. core-loader's compiled output imports @intisy-ai/api by name, and api sits under
// core-loader rather than beside it, so a top-level-only store leaves that import unresolvable.
// One library reachable by two paths is materialised once, from the shallowest, since both paths
// are the same checkout of the same commit.
export function materializableLibraries(sourceDir: string): SharedLibrary[] {
  const shallowest = new Map<string, { library: SharedLibrary; depth: number }>();
  for (const library of declaredLibraryTree(sourceDir)) {
    const depth = path.relative(sourceDir, library.dir).split(path.sep).length;
    const seen = shallowest.get(library.specifier);
    if (!seen || depth < seen.depth) shallowest.set(library.specifier, { library, depth });
  }
  return [...shallowest.values()].map((entry) => entry.library);
}

// A declared library with no build output cannot be put in a home's store, so any plugin
// importing it by name fails to load. Callers use this to refuse the deploy fast path: only a
// build produces the dist, and skipping the build is what leaves the home unable to repair itself.
export function unbuiltLibraries(sourceDir: string): SharedLibrary[] {
  return declaredLibraries(sourceDir).filter((library) => !fs.existsSync(path.join(library.dir, "dist")));
}

function copyDirectory(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) copyDirectory(source, target);
    else fs.copyFileSync(source, target);
  }
}

export interface MaterializeResult {
  specifier: string;
  status: "written" | "current" | "skipped";
  detail?: string;
}

// What materializeLibraries synthesizes and writes for a library, kept as a type so the
// "is the store already correct" check can compare against it field by field.
interface SharedLibraryManifest {
  name: string;
  version: string;
  main: string;
  type?: string;
  // Mirrored from the library's own declaration, because a subpath like `@intisy-ai/api/engine`
  // resolves through `exports` and through nothing else: without it Node looks for an `engine.js`
  // beside the package root and the import fails, however complete the copied files are.
  exports?: unknown;
}

/**
 * The directories a library's own `package.json` actually points at.
 *
 * @remarks
 * Derived rather than assumed. Most libraries here ship `dist/`, but `api` ships `generated/`, and
 * a store built on the assumption copies files nothing references while leaving `main` pointing at
 * a file that was never copied. Every path in `main`, `types` and `exports` contributes its first
 * segment, so a library is carried by what it declares rather than by what it is expected to look
 * like.
 */
function referencedDirs(pkg: { main?: string; types?: string; exports?: unknown }): string[] {
  const dirs = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value !== "string" || !value.startsWith(".")) return;
    const [first] = value.replace(/^\.\/?/, "").split("/");
    if (first && first !== "." && !first.endsWith(".js") && !first.endsWith(".json")) dirs.add(first);
  };
  const walk = (value: unknown): void => {
    if (typeof value === "string") { add(value); return; }
    if (value && typeof value === "object") for (const nested of Object.values(value)) walk(nested);
  };
  add(pkg.main);
  add(pkg.types);
  walk(pkg.exports);
  return dirs.size > 0 ? [...dirs] : ["dist"];
}

// Compared field by field, not by stringifying both sides, so key order never forces a
// pointless re-copy. A store written by an older version of this function (e.g. one that
// hardcoded "type": "module") must be judged stale even when the version string hasn't
// moved: libraries in this ecosystem change commits far more often than they change versions,
// so a version-only check can never see a metadata correction like the mirrored "type" field.
function readStoreManifest(target: string): Partial<SharedLibraryManifest> | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(target, "package.json"), "utf8")) as Partial<SharedLibraryManifest>;
  } catch {
    return undefined;
  }
}

function storeMatches(
  target: string,
  expected: SharedLibraryManifest,
  pkg: Partial<SharedLibraryManifest> | undefined,
  dirs: string[],
): boolean {
  if (!dirs.every((dir) => fs.existsSync(path.join(target, dir)))) return false;
  if (JSON.stringify(pkg?.exports ?? null) !== JSON.stringify(expected.exports ?? null)) return false;
  return pkg?.name === expected.name && pkg?.version === expected.version && pkg?.main === expected.main && pkg?.type === expected.type;
}

// Plain x.y.z versions only, compared numerically segment by segment (never as a semver
// range or with prerelease ordering, neither of which this ecosystem's libraries use). A
// missing or non-numeric segment reads as 0 rather than throwing, so a malformed store entry
// never blocks a repair.
export function isVersionHigherThan(a: string, b: string): boolean {
  const segmentsA = a.split(".");
  const segmentsB = b.split(".");
  const length = Math.max(segmentsA.length, segmentsB.length);
  for (let i = 0; i < length; i++) {
    const valueA = Number.parseInt(segmentsA[i] ?? "", 10) || 0;
    const valueB = Number.parseInt(segmentsB[i] ?? "", 10) || 0;
    if (valueA !== valueB) return valueA > valueB;
  }
  return false;
}

// Places each library the clone declares into the home's shared store, so anything
// importing it by name resolves through ordinary Node lookup. The library's own dist
// is copied verbatim; nothing is rewritten.
export function materializeLibraries(
  sourceDir: string,
  configDir: string,
  writeLog: (message: string, isError?: boolean) => void = () => {},
): MaterializeResult[] {
  const results: MaterializeResult[] = [];

  for (const library of materializableLibraries(sourceDir)) {
    let version = "0.0.0";
    let main = "dist/index.js";
    let type: string | undefined; // mirrors the source library's own declaration; core-loader has none (CommonJS)
    let declared: { main?: string; types?: string; exports?: unknown } = {};
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(library.dir, "package.json"), "utf8")) as {
        version?: string;
        main?: string;
        types?: string;
        type?: string;
        exports?: unknown;
      };
      declared = pkg;
      if (typeof pkg.version === "string") version = pkg.version;
      if (typeof pkg.main === "string") main = pkg.main;
      if (typeof pkg.type === "string") type = pkg.type;
    } catch { /* the defaults below are correct for every library that declares nothing */ }

    // A library is "not built" when NONE of what it points at is present. Requiring all of them
    // would refuse a library whose optional subpath happens not to be generated in this checkout.
    const dirs = referencedDirs(declared).filter((dir) => fs.existsSync(path.join(library.dir, dir)));
    if (dirs.length === 0) {
      results.push({ specifier: library.specifier, status: "skipped", detail: "not built" });
      continue;
    }

    const target = path.join(sharedStoreDir(configDir), ...library.specifier.split("/"));
    const manifest: SharedLibraryManifest = { name: library.specifier, version, main };
    if (type !== undefined) manifest.type = type;
    if (declared.exports !== undefined) manifest.exports = declared.exports;

    const storedPkg = readStoreManifest(target);

    // Every plugin clone that carries this library writes into the same slot, and clones
    // in the same home can lag on different release channels. Whichever deployed last must
    // not be allowed to downgrade a slot another clone already brought up to date.
    if (dirs.some((dir) => fs.existsSync(path.join(target, dir))) && storedPkg?.version !== undefined && isVersionHigherThan(storedPkg.version, version)) {
      results.push({ specifier: library.specifier, status: "skipped", detail: `kept ${storedPkg.version} over ${version}` });
      writeLog(`Kept ${library.specifier}@${storedPkg.version}, incoming ${version} is not newer`);
      continue;
    }

    // Callers run this on every deploy so a home that predates the store still gets
    // one, which means the common case is "already correct" and must not re-copy.
    if (storeMatches(target, manifest, storedPkg, dirs)) {
      results.push({ specifier: library.specifier, status: "current", detail: version });
      continue;
    }
    try {
      fs.rmSync(target, { recursive: true, force: true });
      for (const dir of dirs) copyDirectory(path.join(library.dir, dir), path.join(target, dir));
      // A package.json is what makes the directory resolvable by name at all.
      fs.writeFileSync(path.join(target, "package.json"), JSON.stringify(manifest, null, 2), "utf8");
      results.push({ specifier: library.specifier, status: "written", detail: version });
      writeLog(`Shared ${library.specifier}@${version}`);
    } catch (e: unknown) {
      results.push({ specifier: library.specifier, status: "skipped", detail: "copy failed" });
      writeLog(`Could not share ${library.specifier}: ${(e as { message: string }).message}`, true);
    }
  }

  return results;
}

// <pluginDir>/node_modules is a store this plugin wrote before the shared store moved to
// sharedStoreDir (the home root). Nothing writes that location any more, but a deployed
// bundle at <pluginDir>/<id>.js resolves the CLOSER directory first, so a stale copy left
// there silently shadows the real store forever. Removing it here makes every existing
// home self-heal on its next deploy pass.
export function pruneAbandonedPluginStore(
  pluginDir: string,
  configDir: string,
  writeLog: (message: string, isError?: boolean) => void = () => {},
): void {
  const abandoned = path.join(pluginDir, "node_modules");
  const realStore = sharedStoreDir(configDir);
  if (path.resolve(abandoned) === path.resolve(realStore)) return;
  if (!fs.existsSync(abandoned)) return;

  // Only prune once the real store actually has something in it: removing the abandoned
  // copy first would leave a home with no libraries at all if the real store is still empty.
  const realStorePopulated = fs.existsSync(realStore) && fs.readdirSync(realStore).length > 0;
  if (!realStorePopulated) return;

  // A locked file (Windows) must never fail the caller's deploy; retried on the next pass.
  try {
    fs.rmSync(abandoned, { recursive: true, force: true });
    writeLog(`Removed abandoned library store at ${abandoned}`);
  } catch (e: unknown) {
    writeLog(`Could not remove abandoned library store at ${abandoned}: ${(e as { message: string }).message}`, true);
  }
}
