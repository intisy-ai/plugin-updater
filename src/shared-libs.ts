// A home's shared library store is core's: it is where a home resolves a bundle's imports from,
// not a decision this plugin makes. Re-exported here so this repo's imports name one module.
// @ts-ignore - generated bundle, no .d.ts
export {
  materializeLibraries,
  declaredLibraries,
  dropLibrary,
  mergeRange,
  pruneAbandonedPluginStore,
  sharedStoreDir,
} from "@intisy-ai/basekit";
export type { SharedLibrary, MaterializeResult, MergedRange, StoreInstaller } from "@intisy-ai/basekit";
