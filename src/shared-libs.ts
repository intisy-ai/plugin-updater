// A home's shared library store is core's: it is where a home resolves a bundle's imports from,
// not a decision this plugin makes. Re-exported here so this repo's imports name one module.
// @ts-ignore - generated bundle, no .d.ts
export {
  materializeLibraries,
  materializableLibraries,
  declaredLibraries,
  declaredLibraryTree,
  unbuiltLibraries,
  pruneAbandonedPluginStore,
  sharedStoreDir,
  isVersionHigherThan,
} from "@intisy-ai/core";
export type { SharedLibrary, MaterializeResult } from "@intisy-ai/core";
