import * as vscode from 'vscode';
import { configurationFileName, getConfigurationFullFileName, loadConfiguration, PyboardDevConfiguration } from './utils/configuration';
import { logChannelOutput } from './output-channel';

const statusBarSelectCommunicationId = 'mekatrol.pyboarddev.selectdevice';

let statusBarItem: vscode.StatusBarItem | undefined = undefined;

export const initStatusBar = async (context: vscode.ExtensionContext): Promise<void> => {
  // Create device name status bar item
  createDeviceNameStatusBarItem(context);

  // Update status bar item once at start
  await updateStatusBarItem();

  const watcher = vscode.workspace.createFileSystemWatcher(`**/${configurationFileName}`);
  watcher.onDidCreate((_uri) => updateStatusBarItem());
  watcher.onDidChange((_uri) => updateStatusBarItem());
  watcher.onDidDelete((_uri) => updateStatusBarItem());
};

export const updateStatusBarItem = async (): Promise<void> => {
  if (!statusBarItem) {
    return;
  }

  const configurationFilePath = getConfigurationFullFileName();

  if (!configurationFilePath) {
    statusBarItem.hide();
    return;
  }

  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(configurationFilePath));

    const config = await loadConfiguration();

    statusBarItem.text = `$(circuit-board) ${getDeviceName(config)} [${config.baudrate}]`;

    statusBarItem.backgroundColor = config.device && config.device.length ? undefined : new vscode.ThemeColor('statusBarItem.errorBackground');
  } catch {
    // Hide status bar on error (eg configuration file does not exist)
    statusBarItem.hide();
  }

  statusBarItem.show();
};

const createDeviceNameStatusBarItem = (context: vscode.ExtensionContext) => {
  // Register select device command handler
  context.subscriptions.push(
    vscode.commands.registerCommand(statusBarSelectCommunicationId, () => {
      loadConfiguration().then((c) => {
        if (!c.device || c.device.length === 0) {
          logChannelOutput('Please select a serial port device!');
          return;
        }

        logChannelOutput(`${getDeviceName(c)} [${c.baudrate}]`);
      });
    })
  );

  // Create select device status bar item
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = statusBarSelectCommunicationId;
  context.subscriptions.push(statusBarItem);

  // Register listeners for file updates
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(updateStatusBarItem));
  context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection(updateStatusBarItem));
};

const getDeviceName = (config: PyboardDevConfiguration): string => {
  const device = config.device && config.device.length ? config.device : '<select device>';
  return device;
};
