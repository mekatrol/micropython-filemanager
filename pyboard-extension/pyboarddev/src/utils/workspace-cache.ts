/**
 * Module overview:
 * Manages persisted per-workspace cache data stored in `.pydevice/settings.json`.
 */
import * as vscode from 'vscode';
import { posix } from 'path';
import { pyDeviceTimeoutSettings } from '../constants/timeout-constants';
import { pydeviceDirectoryName } from './configuration';

export const workspaceCacheFileName = `${pydeviceDirectoryName}/settings.json`;
export const autoReconnectDevicesCacheKey = 'autoReconnectDevices';
export const loggerAutoStartCacheKey = 'loggerAutoStart';

type WorkspaceCache = Record<string, unknown>;

const defaultTimeoutSettingsCache: WorkspaceCache = Object.fromEntries(
  Object.values(pyDeviceTimeoutSettings).map((setting) => [setting.settingKey, setting.defaultValueMs])
);

const defaultWorkspaceCache: WorkspaceCache = {
  [autoReconnectDevicesCacheKey]: false,
  [loggerAutoStartCacheKey]: true,
  reconnectDevicePaths: [],
  replHistoryByDevice: {},
  ...defaultTimeoutSettingsCache
};

let cacheState: WorkspaceCache = {};
let writeChain: Promise<void> = Promise.resolve();

const isObjectRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const getWorkspaceRootUri = (): vscode.Uri | undefined => {
  return vscode.workspace.workspaceFolders?.[0]?.uri;
};

const getWorkspaceFileUri = (fileName: string): vscode.Uri | undefined => {
  const workspaceUri = getWorkspaceRootUri();
  if (!workspaceUri) {
    return undefined;
  }

  return workspaceUri.with({
    path: posix.join(workspaceUri.path, fileName)
  });
};

const loadCacheFromFile = async (fileName: string): Promise<WorkspaceCache | undefined> => {
  const fileUri = getWorkspaceFileUri(fileName);
  if (!fileUri) {
    return {};
  }

  try {
    const content = await vscode.workspace.fs.readFile(fileUri);
    const parsed = JSON.parse(Buffer.from(content).toString('utf8'));
    return isObjectRecord(parsed) ? parsed : {};
  } catch {
    return undefined;
  }
};

const saveCacheToPrimaryFile = async (): Promise<void> => {
  const fileUri = getWorkspaceFileUri(workspaceCacheFileName);
  if (!fileUri) {
    return;
  }
  const workspaceUri = getWorkspaceRootUri();
  if (!workspaceUri) {
    return;
  }
  const pydeviceDirUri = workspaceUri.with({
    path: posix.join(workspaceUri.path, pydeviceDirectoryName)
  });
  await vscode.workspace.fs.createDirectory(pydeviceDirUri);

  const content = JSON.stringify(cacheState, null, 2);
  await vscode.workspace.fs.writeFile(fileUri, Buffer.from(content, 'utf8'));
};

export const initialiseWorkspaceCache = async (): Promise<void> => {
  const primary = await loadCacheFromFile(workspaceCacheFileName);
  if (primary !== undefined) {
    const merged = { ...defaultWorkspaceCache, ...primary };
    cacheState = merged;
    if (JSON.stringify(primary) !== JSON.stringify(merged)) {
      await saveCacheToPrimaryFile();
    }
    return;
  }

  // Create default state
  cacheState = { ...defaultWorkspaceCache };
  await saveCacheToPrimaryFile();
};

export const createDefaultWorkspaceCacheFile = async (): Promise<boolean> => {
  const primary = await loadCacheFromFile(workspaceCacheFileName);
  if (primary !== undefined) {
    const merged = { ...defaultWorkspaceCache, ...primary };
    cacheState = merged;
    if (JSON.stringify(primary) !== JSON.stringify(merged)) {
      await saveCacheToPrimaryFile();
    }
    return false;
  }

  cacheState = { ...defaultWorkspaceCache };
  await saveCacheToPrimaryFile();
  return true;
};

export const getWorkspaceCacheValue = <T>(key: string): T | undefined => {
  return cacheState[key] as T | undefined;
};

export const setWorkspaceCacheValue = async (key: string, value: unknown): Promise<void> => {
  if (value === undefined) {
    delete cacheState[key];
  } else {
    cacheState[key] = value;
  }

  writeChain = writeChain.then(async () => {
    await saveCacheToPrimaryFile();
  });
  await writeChain;
};
