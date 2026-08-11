import fs from "node:fs";
import path from "node:path";

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

function readGitmodules(dir: string): string {
  try {
    return fs.readFileSync(path.join(dir, ".gitmodules"), "utf8");
  } catch {
    return "";
  }
}

function submodulePaths(gitmodules: string): string[] {
  return gitmodules
    .split("\n")
    .map((line) => /^\s*path\s*=\s*(.+)$/.exec(line.trim())?.[1]?.trim())
    .filter((value): value is string => Boolean(value));
}

// Every submodule under a clone, nested ones included, as paths relative to it. A library
// can itself carry libraries (core-proxy nests core-ir), and each has its own build output,
// so anything reasoning about "what this clone builds" has to see the whole tree.
export function submoduleTree(sourceDir: string, relative = ""): string[] {
  const found: string[] = [];
  for (const child of submodulePaths(readGitmodules(path.join(sourceDir, relative)))) {
    const childPath = relative ? path.join(relative, child) : child;
    found.push(childPath, ...submoduleTree(sourceDir, childPath));
  }
  return found;
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
  return librariesAt(sourceDir, submodulePaths(readGitmodules(sourceDir)));
}

// The same set widened to the whole submodule tree. Asking "does anything still declare this
// library" has to see the nested ones too (core-proxy nests core-ir), or a store entry a
// plugin genuinely depends on is credited to nobody and reads as left over.
export function declaredLibraryTree(sourceDir: string): SharedLibrary[] {
  return librariesAt(sourceDir, submoduleTree(sourceDir));
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

function alreadyShared(target: string, version: string): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(target, "package.json"), "utf8")) as { version?: string };
    return pkg.version === version && fs.existsSync(path.join(target, "dist"));
  } catch {
    return false;
  }
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

  for (const library of declaredLibraries(sourceDir)) {
    const dist = path.join(library.dir, "dist");
    if (!fs.existsSync(dist)) {
      results.push({ specifier: library.specifier, status: "skipped", detail: "not built" });
      continue;
    }

    let version = "0.0.0";
    let main = "dist/index.js";
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(library.dir, "package.json"), "utf8")) as {
        version?: string;
        main?: string;
      };
      if (typeof pkg.version === "string") version = pkg.version;
      if (typeof pkg.main === "string") main = pkg.main;
    } catch { /* the defaults above are correct for every library in this ecosystem */ }

    const target = path.join(sharedStoreDir(configDir), ...library.specifier.split("/"));
    // Callers run this on every deploy so a home that predates the store still gets
    // one, which means the common case is "already correct" and must not re-copy.
    if (alreadyShared(target, version)) {
      results.push({ specifier: library.specifier, status: "current", detail: version });
      continue;
    }
    try {
      fs.rmSync(target, { recursive: true, force: true });
      copyDirectory(dist, path.join(target, "dist"));
      // A package.json is what makes the directory resolvable by name at all, and
      // type: module is what stops Node re-parsing each ESM bundle on import.
      fs.writeFileSync(
        path.join(target, "package.json"),
        JSON.stringify({ name: library.specifier, version, type: "module", main }, null, 2),
        "utf8",
      );
      results.push({ specifier: library.specifier, status: "written", detail: version });
      writeLog(`Shared ${library.specifier}@${version}`);
    } catch (e: unknown) {
      results.push({ specifier: library.specifier, status: "skipped", detail: "copy failed" });
      writeLog(`Could not share ${library.specifier}: ${(e as { message: string }).message}`, true);
    }
  }

  return results;
}
