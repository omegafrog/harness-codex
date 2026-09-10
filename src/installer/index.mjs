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
  updateProject,
  writeHarnessLock,
} from "./update.mjs";
