/**
 * Module overview:
 * Loads, normalises, validates, and persists workspace PyDevice
 * configuration from `.pydevice/config.json`.
 */
import * as vscode from 'vscode';
import { posix } from 'path';

export const pydeviceDirectoryName = '.pydevice';
export const configurationFileName = `${pydeviceDirectoryName}/config.json`;

export enum PyDeviceConfigurationResult {
  AlreadyExists = 'AlreadyExists',
  Created = 'Created',
  Error = 'Error',
  NoWorkspace = 'NoWorkspace'
}

interface DeviceConfigurationJson {
  hostFolder?: string;
  libraryFolders?: string[];
  name?: string;
  syncExcludedPaths?: string[];
}

const isObjectRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const normaliseOptionalString = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
};

const normaliseRelativePath = (value: string | undefined): string | undefined => {
  if (!value) {
    return undefined;
  }

  const normalised = value
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  return normalised.length > 0 ? normalised : undefined;
};

const normaliseRelativePathArray = (values: readonly string[] | undefined): string[] => {
  if (!values || values.length === 0) {
    return [];
  }

  return [...new Set(values
    .map((value) => normaliseRelativePath(value))
    .filter((value): value is string => !!value))]
    .sort((a, b) => a.localeCompare(b));
};

export class DeviceConfiguration {
  private hostFolder: string | undefined;
  private libraryFolders: string[] = [];
  private name: string | undefined;
  private syncExcludedPaths: string[] = [];

  constructor(initial?: DeviceConfigurationJson) {
    this.hostFolder = normaliseOptionalString(initial?.hostFolder);
    this.libraryFolders = normaliseRelativePathArray(initial?.libraryFolders);
    this.name = normaliseOptionalString(initial?.name);
    this.syncExcludedPaths = normaliseRelativePathArray(initial?.syncExcludedPaths);
  }

  static fromUnknown(value: unknown): DeviceConfiguration {
    if (value instanceof DeviceConfiguration) {
      return new DeviceConfiguration(value.toJSON());
    }

    if (!isObjectRecord(value)) {
      return new DeviceConfiguration();
    }

    const hostFolder = typeof value.hostFolder === 'string' ? value.hostFolder : undefined;
    const libraryFolders = Array.isArray(value.libraryFolders)
      ? value.libraryFolders.filter((item): item is string => typeof item === 'string')
      : undefined;
    const name = typeof value.name === 'string' ? value.name : undefined;
    const syncExcludedPaths = Array.isArray(value.syncExcludedPaths)
      ? value.syncExcludedPaths.filter((item): item is string => typeof item === 'string')
      : undefined;
    return new DeviceConfiguration({ hostFolder, libraryFolders, name, syncExcludedPaths });
  }

  getHostFolder(): string | undefined {
    return this.hostFolder;
  }

  setHostFolder(value: string | undefined): void {
    this.hostFolder = normaliseOptionalString(value);
  }

  getLibraryFolders(): string[] {
    return [...this.libraryFolders];
  }

  setLibraryFolders(values: readonly string[] | undefined): void {
    this.libraryFolders = normaliseRelativePathArray(values);
  }

  getName(): string | undefined {
    return this.name;
  }

  setName(value: string | undefined): void {
    this.name = normaliseOptionalString(value);
  }

  getSyncExcludedPaths(): string[] {
    return [...this.syncExcludedPaths];
  }

  setSyncExcludedPaths(values: readonly string[] | undefined): void {
    this.syncExcludedPaths = normaliseRelativePathArray(values);
  }

  addSyncExcludedPath(relativePath: string): void {
    const normalised = normaliseRelativePath(relativePath);
    if (!normalised || this.syncExcludedPaths.includes(normalised)) {
      return;
    }
    this.syncExcludedPaths = [...this.syncExcludedPaths, normalised].sort((a, b) => a.localeCompare(b));
  }

  removeSyncExcludedPath(relativePath: string): void {
    const normalised = normaliseRelativePath(relativePath);
    if (!normalised) {
      return;
    }
    this.syncExcludedPaths = this.syncExcludedPaths.filter((item) => item !== normalised);
  }

  isEmpty(): boolean {
    return !this.hostFolder && this.libraryFolders.length === 0 && !this.name && this.syncExcludedPaths.length === 0;
  }

  toJSON(): DeviceConfigurationJson {
    const json: DeviceConfigurationJson = {};
    if (this.hostFolder) {
      json.hostFolder = this.hostFolder;
    }
    if (this.libraryFolders.length > 0) {
      json.libraryFolders = [...this.libraryFolders];
    }
    if (this.name) {
      json.name = this.name;
    }
    if (this.syncExcludedPaths.length > 0) {
      json.syncExcludedPaths = [...this.syncExcludedPaths];
    }
    return json;
  }
}

export interface PyDeviceConfiguration {
  devices: Record<string, DeviceConfiguration>;
}

export interface MetaPyDeviceConfiguration {
  version: number;
  help: string;
}

export interface PyDeviceConfigurationWithMeta extends PyDeviceConfiguration {
  meta: MetaPyDeviceConfiguration;
}

export const defaultConfiguration: PyDeviceConfiguration = {
  devices: {}
};

const configurationUpdatedEmitter = new vscode.EventEmitter<PyDeviceConfiguration>();
export const onPyDeviceConfigurationUpdated = configurationUpdatedEmitter.event;

interface LegacyPyDeviceConfiguration {
  deviceHostFolderMappings?: Record<string, unknown>;
  deviceNames?: Record<string, unknown>;
}

const cloneDevices = (devices: Record<string, DeviceConfiguration>): Record<string, DeviceConfiguration> => {
  const next: Record<string, DeviceConfiguration> = {};
  for (const [deviceId, device] of Object.entries(devices)) {
    next[deviceId] = DeviceConfiguration.fromUnknown(device);
  }
  return next;
};

const pruneEmptyDevices = (devices: Record<string, DeviceConfiguration>): Record<string, DeviceConfiguration> => {
  const next: Record<string, DeviceConfiguration> = {};
  for (const [deviceId, device] of Object.entries(devices)) {
    if (!device.isEmpty()) {
      next[deviceId] = device;
    }
  }
  return next;
};

const parseDevices = (source: Partial<PyDeviceConfiguration> & LegacyPyDeviceConfiguration): Record<string, DeviceConfiguration> => {
  const devices: Record<string, DeviceConfiguration> = {};
  const legacyMappings = isObjectRecord(source.deviceHostFolderMappings) ? source.deviceHostFolderMappings : {};
  for (const [deviceId, hostFolder] of Object.entries(legacyMappings)) {
    if (typeof hostFolder !== 'string') {
      continue;
    }
    const device = devices[deviceId] ?? new DeviceConfiguration();
    device.setHostFolder(hostFolder);
    devices[deviceId] = device;
  }

  const legacyNames = isObjectRecord(source.deviceNames) ? source.deviceNames : {};
  for (const [deviceId, name] of Object.entries(legacyNames)) {
    if (typeof name !== 'string') {
      continue;
    }
    const device = devices[deviceId] ?? new DeviceConfiguration();
    device.setName(name);
    devices[deviceId] = device;
  }

  const rawDevices = isObjectRecord(source.devices) ? source.devices : {};
  for (const [deviceId, rawDevice] of Object.entries(rawDevices)) {
    const parsed = DeviceConfiguration.fromUnknown(rawDevice);
    const device = devices[deviceId] ?? new DeviceConfiguration();
    device.setHostFolder(parsed.getHostFolder() ?? device.getHostFolder());
    device.setLibraryFolders(parsed.getLibraryFolders());
    device.setName(parsed.getName() ?? device.getName());
    device.setSyncExcludedPaths(parsed.getSyncExcludedPaths());
    devices[deviceId] = device;
  }

  return pruneEmptyDevices(devices);
};

const findDuplicateNames = (devices: Record<string, DeviceConfiguration>): Array<{ name: string; deviceIds: string[] }> => {
  const nameBuckets = new Map<string, { name: string; deviceIds: string[] }>();
  for (const [deviceId, device] of Object.entries(devices)) {
    const name = device.getName()?.trim();
    if (!name) {
      continue;
    }

    const key = name.toLocaleLowerCase();
    const existing = nameBuckets.get(key);
    if (existing) {
      existing.deviceIds.push(deviceId);
    } else {
      nameBuckets.set(key, { name, deviceIds: [deviceId] });
    }
  }

  return [...nameBuckets.values()]
    .filter((item) => item.deviceIds.length > 1)
    .map((item) => ({ name: item.name, deviceIds: [...item.deviceIds].sort((a, b) => a.localeCompare(b)) }))
    .sort((a, b) => a.name.localeCompare(b.name));
};

export const getDeviceHostFolderMappings = (configuration: PyDeviceConfiguration): Record<string, string> => {
  const mappings: Record<string, string> = {};
  for (const [deviceId, device] of Object.entries(configuration.devices ?? {})) {
    const hostFolder = device.getHostFolder();
    if (hostFolder) {
      mappings[deviceId] = hostFolder;
    }
  }
  return mappings;
};

export const getDeviceLibraryFolderMappings = (configuration: PyDeviceConfiguration): Record<string, string[]> => {
  const mappings: Record<string, string[]> = {};
  for (const [deviceId, device] of Object.entries(configuration.devices ?? {})) {
    const folders = device.getLibraryFolders();
    if (folders.length > 0) {
      mappings[deviceId] = folders;
    }
  }
  return mappings;
};

export const getDeviceNames = (configuration: PyDeviceConfiguration): Record<string, string> => {
  const names: Record<string, string> = {};
  for (const [deviceId, device] of Object.entries(configuration.devices ?? {})) {
    const name = device.getName();
    if (name) {
      names[deviceId] = name;
    }
  }
  return names;
};

export const getDeviceSyncExcludedPaths = (configuration: PyDeviceConfiguration): Record<string, string[]> => {
  const excludedPathsByDevice: Record<string, string[]> = {};
  for (const [deviceId, device] of Object.entries(configuration.devices ?? {})) {
    const excludedPaths = device.getSyncExcludedPaths();
    if (excludedPaths.length > 0) {
      excludedPathsByDevice[deviceId] = excludedPaths;
    }
  }
  return excludedPathsByDevice;
};

export const getConfigurationFullFileName = (): string | undefined => {
  if (!vscode.workspace.workspaceFolders) {
    // Return undefined if there is no workspace for a configuration file
    return undefined;
  }

  const folderUri = vscode.workspace.workspaceFolders[0].uri;
  const fileUri = folderUri.with({
    path: posix.join(folderUri.path, configurationFileName)
  });

  // VS code prefixes windows paths with '/', e.g. '/c:/file.txt' so remove prefix and replace '/' with '\'
  const path = process.platform === 'win32' ? fileUri.path.substring(1).replace(/\//g, '\\') : fileUri.path;

  // Return the configuration file path
  return path;
};

export const loadConfiguration = async (): Promise<PyDeviceConfiguration> => {
  let configuration: PyDeviceConfiguration = {
    ...defaultConfiguration,
    devices: {}
  };

  if (!vscode.workspace.workspaceFolders) {
    // Return default if there is no workspace configuration file
    return configuration;
  }

  try {
    const folderUri = vscode.workspace.workspaceFolders[0].uri;
    const fileUri = folderUri.with({
      path: posix.join(folderUri.path, configurationFileName)
    });

    const fileContent = await vscode.workspace.fs.readFile(fileUri);
    const json = Buffer.from(fileContent).toString('utf8');
    const newConfiguration = JSON.parse(json) as Partial<PyDeviceConfiguration> & LegacyPyDeviceConfiguration;

    configuration = {
      ...configuration,
      devices: parseDevices(newConfiguration)
    };

    // The configuration comes from user entered value on disk, given this transpiles to
    // JavaScript then the user can override values to invalid values without error.
    // So we validate settings...
  } catch {
    /* ignore errors if config file does not exist */
  }

  return configuration;
};

const getConfigurationFileUri = (): vscode.Uri | undefined => {
  if (!vscode.workspace.workspaceFolders) {
    return undefined;
  }

  const folderUri = vscode.workspace.workspaceFolders[0].uri;
  return folderUri.with({
    path: posix.join(folderUri.path, configurationFileName)
  });
};

const ensurePyDeviceDirectory = async (): Promise<void> => {
  const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!folderUri) {
    return;
  }
  const pydeviceDirUri = folderUri.with({
    path: posix.join(folderUri.path, pydeviceDirectoryName)
  });
  await vscode.workspace.fs.createDirectory(pydeviceDirUri);
};

export const saveConfiguration = async (configuration: PyDeviceConfiguration): Promise<void> => {
  const fileUri = getConfigurationFileUri();
  if (!fileUri) {
    throw new Error('Open a workspace to save PyDevice configuration.');
  }
  await ensurePyDeviceDirectory();

  let existing: PyDeviceConfigurationWithMeta = {
    meta: {
      version: 1,
      help: 'See: https://github.com/mekatrol/micropython-filemanager/blob/main/pydevice-extension/pydevice/README.md for description of configuration values.'
    },
    ...defaultConfiguration,
    devices: {}
  };

  try {
    const fileContent = await vscode.workspace.fs.readFile(fileUri);
    const json = Buffer.from(fileContent).toString('utf8');
    const parsed = JSON.parse(json) as Partial<PyDeviceConfigurationWithMeta> & LegacyPyDeviceConfiguration;
    const meta = parsed.meta ?? existing.meta;
    existing = {
      meta,
      devices: parseDevices(parsed)
    };
  } catch {
    // Missing config is expected; file will be created below.
  }

  const merged: PyDeviceConfigurationWithMeta = {
    meta: existing.meta,
    ...configuration,
    devices: pruneEmptyDevices(cloneDevices(configuration.devices ?? {}))
  };
  const duplicateNames = findDuplicateNames(merged.devices);
  if (duplicateNames.length > 0) {
    const details = duplicateNames.map((item) => `${item.name} (${item.deviceIds.join(', ')})`).join('; ');
    throw new Error(`Duplicate device names are not allowed: ${details}`);
  }

  const content = JSON.stringify(merged, null, 2);
  await vscode.workspace.fs.writeFile(fileUri, Buffer.from(content, 'utf8'));
  configurationUpdatedEmitter.fire(merged);
};

export const updateDeviceHostFolderMapping = async (
  deviceId: string,
  hostFolderRelativePath: string | undefined
): Promise<PyDeviceConfiguration> => {
  const configuration = await loadConfiguration();
  const nextDevices = cloneDevices(configuration.devices ?? {});
  const nextDeviceConfig = nextDevices[deviceId] ?? new DeviceConfiguration();
  nextDeviceConfig.setHostFolder(hostFolderRelativePath);
  if (nextDeviceConfig.isEmpty()) {
    delete nextDevices[deviceId];
  } else {
    nextDevices[deviceId] = nextDeviceConfig;
  }

  const updated: PyDeviceConfiguration = {
    ...configuration,
    devices: pruneEmptyDevices(nextDevices)
  };
  await saveConfiguration(updated);
  return updated;
};

export const updateDeviceName = async (
  deviceId: string,
  name: string | undefined
): Promise<PyDeviceConfiguration> => {
  const configuration = await loadConfiguration();
  const nextDevices = cloneDevices(configuration.devices ?? {});
  const nextDeviceConfig = nextDevices[deviceId] ?? new DeviceConfiguration();
  nextDeviceConfig.setName(name);
  if (nextDeviceConfig.isEmpty()) {
    delete nextDevices[deviceId];
  } else {
    nextDevices[deviceId] = nextDeviceConfig;
  }

  const updated: PyDeviceConfiguration = {
    ...configuration,
    devices: pruneEmptyDevices(nextDevices)
  };
  await saveConfiguration(updated);
  return updated;
};

export const updateDeviceLibraryFolders = async (
  deviceId: string,
  libraryFolderRelativePaths: readonly string[]
): Promise<PyDeviceConfiguration> => {
  const configuration = await loadConfiguration();
  const nextDevices = cloneDevices(configuration.devices ?? {});
  const nextDeviceConfig = nextDevices[deviceId] ?? new DeviceConfiguration();
  nextDeviceConfig.setLibraryFolders(libraryFolderRelativePaths);
  if (nextDeviceConfig.isEmpty()) {
    delete nextDevices[deviceId];
  } else {
    nextDevices[deviceId] = nextDeviceConfig;
  }

  const updated: PyDeviceConfiguration = {
    ...configuration,
    devices: pruneEmptyDevices(nextDevices)
  };
  await saveConfiguration(updated);
  return updated;
};

export const updateDeviceSyncExclusion = async (
  deviceId: string,
  relativePath: string,
  excluded: boolean
): Promise<PyDeviceConfiguration> => {
  const configuration = await loadConfiguration();
  const nextDevices = cloneDevices(configuration.devices ?? {});
  const nextDeviceConfig = nextDevices[deviceId] ?? new DeviceConfiguration();
  if (excluded) {
    nextDeviceConfig.addSyncExcludedPath(relativePath);
  } else {
    nextDeviceConfig.removeSyncExcludedPath(relativePath);
  }

  if (nextDeviceConfig.isEmpty()) {
    delete nextDevices[deviceId];
  } else {
    nextDevices[deviceId] = nextDeviceConfig;
  }

  const updated: PyDeviceConfiguration = {
    ...configuration,
    devices: pruneEmptyDevices(nextDevices)
  };
  await saveConfiguration(updated);
  return updated;
};

export const updateDeviceSyncExcludedPaths = async (
  deviceId: string,
  relativePaths: readonly string[]
): Promise<PyDeviceConfiguration> => {
  const configuration = await loadConfiguration();
  const nextDevices = cloneDevices(configuration.devices ?? {});
  const nextDeviceConfig = nextDevices[deviceId] ?? new DeviceConfiguration();
  nextDeviceConfig.setSyncExcludedPaths(relativePaths);

  if (nextDeviceConfig.isEmpty()) {
    delete nextDevices[deviceId];
  } else {
    nextDevices[deviceId] = nextDeviceConfig;
  }

  const updated: PyDeviceConfiguration = {
    ...configuration,
    devices: pruneEmptyDevices(nextDevices)
  };
  await saveConfiguration(updated);
  return updated;
};

export const createDefaultConfiguration = async (): Promise<[PyDeviceConfigurationResult, string?]> => {
  let configuration: PyDeviceConfigurationWithMeta = Object.assign(
    {
      meta: {
        version: 1,
        help: 'See: https://github.com/mekatrol/micropython-filemanager/blob/main/pydevice-extension/pydevice/README.md for description of configuration values.'
      }
    },
    defaultConfiguration
  );

  if (!vscode.workspace.workspaceFolders) {
    // Return default if there is no workspace configuration file
    return [PyDeviceConfigurationResult.NoWorkspace, undefined];
  }

  try {
    const workspaceFolder = vscode.workspace.workspaceFolders[0];

    const folderUri = workspaceFolder.uri;

    const fileUri = folderUri.with({
      path: posix.join(folderUri.path, configurationFileName)
    });

    // VS code prefixes windows paths with '/', e.g. '/c:/file.txt' so remove prefix and replace '/' with '\'
    const path = process.platform === 'win32' ? fileUri.path.substring(1).replace(/\//g, '\\') : fileUri.path;

    // Does the file already exist?
    try {
      if ((await vscode.workspace.fs.stat(fileUri)) !== undefined) {
        return [PyDeviceConfigurationResult.AlreadyExists, path];
      }
    } catch {
      /* ignore */
    }

    const content = JSON.stringify(configuration, null, 2);

    // Create the file
    const writeData = Buffer.from(content, 'utf8');
    await ensurePyDeviceDirectory();
    await vscode.workspace.fs.writeFile(fileUri, writeData);

    return [PyDeviceConfigurationResult.Created, path];
  } catch (e) {
    /* ignore errors if config file does not exist */
    return [PyDeviceConfigurationResult.Error, e?.toString()];
  }
};

export const resetDefaultConfiguration = async (): Promise<[PyDeviceConfigurationResult, string?]> => {
  const configuration: PyDeviceConfigurationWithMeta = Object.assign(
    {
      meta: {
        version: 1,
        help: 'See: https://github.com/mekatrol/micropython-filemanager/blob/main/pydevice-extension/pydevice/README.md for description of configuration values.'
      }
    },
    defaultConfiguration
  );

  if (!vscode.workspace.workspaceFolders) {
    return [PyDeviceConfigurationResult.NoWorkspace, undefined];
  }

  try {
    const workspaceFolder = vscode.workspace.workspaceFolders[0];
    const folderUri = workspaceFolder.uri;
    const fileUri = folderUri.with({
      path: posix.join(folderUri.path, configurationFileName)
    });

    const filePath = process.platform === 'win32' ? fileUri.path.substring(1).replace(/\//g, '\\') : fileUri.path;
    const content = JSON.stringify(configuration, null, 2);
    const writeData = Buffer.from(content, 'utf8');
    await ensurePyDeviceDirectory();
    await vscode.workspace.fs.writeFile(fileUri, writeData);

    return [PyDeviceConfigurationResult.Created, filePath];
  } catch (e) {
    return [PyDeviceConfigurationResult.Error, e?.toString()];
  }
};
