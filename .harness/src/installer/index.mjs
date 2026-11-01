export {
  HarnessLockError,
  classifyLockEntries,
  discoverHarnessOwnedFiles,
  hashFile,
  readHarnessLock,
  validateHarnessLock,
} from "./lock.mjs";
export {
  InstallerUpdateError,
  buildHarnessLock,
  discoverManagedAssetPaths,
  updateProject,
  writeHarnessLock,
} from "./update.mjs";
