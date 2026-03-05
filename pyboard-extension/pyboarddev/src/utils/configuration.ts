import * as vscode from 'vscode';
import { posix } from 'path';

export const configurationFileName = '.pyboarddev';

export enum PyboardDevConfigurationResult {
  AlreadyExists = 'AlreadyExists',
  Created = 'Created',
  Error = 'Error',
  NoWorkspace = 'NoWorkspace'
}

interface DeviceConfigurationJson {
  hostFolder?: string;
  alias?: string;
}

const isObjectRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const normaliseOptionalString = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
};

export class DeviceConfiguration {
  private hostFolder: string | undefined;
  private alias: string | undefined;

  constructor(initial?: DeviceConfigurationJson) {
    this.hostFolder = normaliseOptionalString(initial?.hostFolder);
    this.alias = normaliseOptionalString(initial?.alias);
  }

  static fromUnknown(value: unknown): DeviceConfiguration {
    if (value instanceof DeviceConfiguration) {
      return new DeviceConfiguration(value.toJSON());
    }

    if (!isObjectRecord(value)) {
      return new DeviceConfiguration();
    }

    const hostFolder = typeof value.hostFolder === 'string' ? value.hostFolder : undefined;
    const alias = typeof value.alias === 'string' ? value.alias : undefined;
    return new DeviceConfiguration({ hostFolder, alias });
  }

  getHostFolder(): string | undefined {
    return this.hostFolder;
  }

  setHostFolder(value: string | undefined): void {
    this.hostFolder = normaliseOptionalString(value);
  }

  getAlias(): string | undefined {
    return this.alias;
  }

  setAlias(value: string | undefined): void {
    this.alias = normaliseOptionalString(value);
  }

  isEmpty(): boolean {
    return !this.hostFolder && !this.alias;
  }

  toJSON(): DeviceConfigurationJson {
    const json: DeviceConfigurationJson = {};
    if (this.hostFolder) {
      json.hostFolder = this.hostFolder;
    }
    if (this.alias) {
      json.alias = this.alias;
    }
    return json;
  }
}

export interface PyboardDevConfiguration {
  mirrorFolder: string;
  obfuscateOnPull: string[];
  devices: Record<string, DeviceConfiguration>;
}

export interface MetaPyboardDevConfiguration {
  version: number;
  help: string;
}

export interface PyboardDevConfigurationWithMeta extends PyboardDevConfiguration {
  meta: MetaPyboardDevConfiguration;
}

export const defaultConfiguration: PyboardDevConfiguration = {
  mirrorFolder: '',
  obfuscateOnPull: [],
  devices: {}
};

const configurationUpdatedEmitter = new vscode.EventEmitter<PyboardDevConfiguration>();
export const onPyboardDevConfigurationUpdated = configurationUpdatedEmitter.event;

interface LegacyPyboardDevConfiguration {
  deviceHostFolderMappings?: Record<string, unknown>;
  deviceAliases?: Record<string, unknown>;
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

const parseDevices = (source: Partial<PyboardDevConfiguration> & LegacyPyboardDevConfiguration): Record<string, DeviceConfiguration> => {
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

  const legacyAliases = isObjectRecord(source.deviceAliases) ? source.deviceAliases : {};
  for (const [deviceId, alias] of Object.entries(legacyAliases)) {
    if (typeof alias !== 'string') {
      continue;
    }
    const device = devices[deviceId] ?? new DeviceConfiguration();
    device.setAlias(alias);
    devices[deviceId] = device;
  }

  const rawDevices = isObjectRecord(source.devices) ? source.devices : {};
  for (const [deviceId, rawDevice] of Object.entries(rawDevices)) {
    const parsed = DeviceConfiguration.fromUnknown(rawDevice);
    const device = devices[deviceId] ?? new DeviceConfiguration();
    device.setHostFolder(parsed.getHostFolder() ?? device.getHostFolder());
    device.setAlias(parsed.getAlias() ?? device.getAlias());
    devices[deviceId] = device;
  }

  return pruneEmptyDevices(devices);
};

const stripLegacyDeviceFields = <T extends object>(value: T): Omit<T, 'deviceHostFolderMappings' | 'deviceAliases'> => {
  const {
    deviceHostFolderMappings: _legacyMappings,
    deviceAliases: _legacyAliases,
    ...rest
  } = value as T & LegacyPyboardDevConfiguration;
  return rest;
};

export const getDeviceHostFolderMappings = (configuration: PyboardDevConfiguration): Record<string, string> => {
  const mappings: Record<string, string> = {};
  for (const [deviceId, device] of Object.entries(configuration.devices ?? {})) {
    const hostFolder = device.getHostFolder();
    if (hostFolder) {
      mappings[deviceId] = hostFolder;
    }
  }
  return mappings;
};

export const getDeviceAliases = (configuration: PyboardDevConfiguration): Record<string, string> => {
  const aliases: Record<string, string> = {};
  for (const [deviceId, device] of Object.entries(configuration.devices ?? {})) {
    const alias = device.getAlias();
    if (alias) {
      aliases[deviceId] = alias;
    }
  }
  return aliases;
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

export const loadConfiguration = async (): Promise<PyboardDevConfiguration> => {
  let configuration: PyboardDevConfiguration = {
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
    const newConfiguration = JSON.parse(json) as Partial<PyboardDevConfiguration> & LegacyPyboardDevConfiguration;

    configuration = {
      ...configuration,
      ...newConfiguration,
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

export const saveConfiguration = async (configuration: PyboardDevConfiguration): Promise<void> => {
  const fileUri = getConfigurationFileUri();
  if (!fileUri) {
    throw new Error('Open a workspace to save Pyboard Dev configuration.');
  }

  let existing: PyboardDevConfigurationWithMeta = {
    meta: {
      version: 1,
      help: 'See: https://github.com/mekatrol/micropython-filemanager/blob/main/pyboard-extension/pyboarddev/README.md for description of configuration values.'
    },
    ...defaultConfiguration,
    devices: {}
  };

  try {
    const fileContent = await vscode.workspace.fs.readFile(fileUri);
    const json = Buffer.from(fileContent).toString('utf8');
    const parsed = JSON.parse(json) as Partial<PyboardDevConfigurationWithMeta> & LegacyPyboardDevConfiguration;
    existing = {
      ...existing,
      ...parsed,
      devices: parseDevices(parsed)
    };
  } catch {
    // Missing config is expected; file will be created below.
  }

  const existingWithoutLegacy = stripLegacyDeviceFields(existing);
  const merged: PyboardDevConfigurationWithMeta = {
    ...existingWithoutLegacy,
    ...configuration,
    devices: pruneEmptyDevices(cloneDevices(configuration.devices ?? {}))
  };

  const content = JSON.stringify(merged, null, 2);
  await vscode.workspace.fs.writeFile(fileUri, Buffer.from(content, 'utf8'));
  configurationUpdatedEmitter.fire(merged);
};

export const updateDeviceHostFolderMapping = async (
  deviceId: string,
  hostFolderRelativePath: string | undefined
): Promise<PyboardDevConfiguration> => {
  const configuration = await loadConfiguration();
  const nextDevices = cloneDevices(configuration.devices ?? {});
  const nextDeviceConfig = nextDevices[deviceId] ?? new DeviceConfiguration();
  nextDeviceConfig.setHostFolder(hostFolderRelativePath);
  if (nextDeviceConfig.isEmpty()) {
    delete nextDevices[deviceId];
  } else {
    nextDevices[deviceId] = nextDeviceConfig;
  }

  const updated: PyboardDevConfiguration = {
    ...configuration,
    devices: pruneEmptyDevices(nextDevices)
  };
  await saveConfiguration(updated);
  return updated;
};

export const updateDeviceAlias = async (
  deviceId: string,
  alias: string | undefined
): Promise<PyboardDevConfiguration> => {
  const configuration = await loadConfiguration();
  const nextDevices = cloneDevices(configuration.devices ?? {});
  const nextDeviceConfig = nextDevices[deviceId] ?? new DeviceConfiguration();
  nextDeviceConfig.setAlias(alias);
  if (nextDeviceConfig.isEmpty()) {
    delete nextDevices[deviceId];
  } else {
    nextDevices[deviceId] = nextDeviceConfig;
  }

  const updated: PyboardDevConfiguration = {
    ...configuration,
    devices: pruneEmptyDevices(nextDevices)
  };
  await saveConfiguration(updated);
  return updated;
};

export const createDefaultConfiguration = async (): Promise<[PyboardDevConfigurationResult, string?]> => {
  let configuration: PyboardDevConfigurationWithMeta = Object.assign(
    {
      meta: {
        version: 1,
        help: 'See: https://github.com/mekatrol/micropython-filemanager/blob/main/pyboard-extension/pyboarddev/README.md for description of configuration values.'
      }
    },
    defaultConfiguration
  );

  if (!vscode.workspace.workspaceFolders) {
    // Return default if there is no workspace configuration file
    return [PyboardDevConfigurationResult.NoWorkspace, undefined];
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
        return [PyboardDevConfigurationResult.AlreadyExists, path];
      }
    } catch {
      /* ignore */
    }

    const content = JSON.stringify(configuration, null, 2);

    // Create the file
    const writeData = Buffer.from(content, 'utf8');
    await vscode.workspace.fs.writeFile(fileUri, writeData);

    return [PyboardDevConfigurationResult.Created, path];
  } catch (e) {
    /* ignore errors if config file does not exist */
    return [PyboardDevConfigurationResult.Error, e?.toString()];
  }
};

const clampNumberUndefinable = (value: number | undefined, min: number, max: number | undefined = undefined): number | undefined => {
  if (!value) {
    return undefined;
  }

  return clampNumber(value, min, max);
};

const clampNumber = (value: number, min: number, max: number | undefined = undefined): number => {
  if (isNaN(value)) {
    return min;
  }

  if (min && value < min) {
    return min;
  }

  if (max && value > max) {
    return max;
  }

  return value;
};
