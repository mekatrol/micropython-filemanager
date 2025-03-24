import * as vscode from 'vscode';
import { posix } from 'path';

export const configurationFileName = '.pyboarddev';

export enum PyboardDevConfigurationResult {
  AlreadyExists = 'AlreadyExists',
  Created = 'Created',
  Error = 'Error',
  NoWorkspace = 'NoWorkspace'
}

export interface PyboardDevConfiguration {
  device: string;
  baudrate: number;
}

export interface MetaPyboardDevConfiguration {
  version: number;
  help: string;
}

export interface PyboardDevConfigurationWithMeta extends PyboardDevConfiguration {
  meta: MetaPyboardDevConfiguration;
}

export const defaultConfiguration: PyboardDevConfiguration = {
  device: '',
  baudrate: 115200
};

export const loadConfiguration = async (): Promise<PyboardDevConfiguration> => {
  let configuration: PyboardDevConfiguration = Object.assign({}, defaultConfiguration);

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
    const newConfiguration = JSON.parse(json);

    configuration = Object.assign(configuration, newConfiguration);

    // The configuration comes from user entered value on disk, given this transpiles to
    // JavaScript then the user can override values to invalid values without error.
    // So we validate settings...
  } catch {
    /* ignore errors if config file does not exist */
  }

  return configuration;
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
