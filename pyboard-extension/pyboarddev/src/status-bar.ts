import * as vscode from 'vscode';
import { configurationFileName, loadConfiguration, PyboardDevConfiguration } from './utils/configuration';
import { listSerialDevices } from './utils/serial-port';
import { logChannelOutput } from './output-channel';

const statusBarSelectCommunicationId = 'mekatrol.pyboarddev.selectdevice';
const selectedSerialPortStateKey = 'selectedSerialPort';

let statusBarItem: vscode.StatusBarItem | undefined = undefined;
let extensionContext: vscode.ExtensionContext | undefined = undefined;

export const initStatusBar = async (context: vscode.ExtensionContext): Promise<void> => {
  extensionContext = context;

  // Create device name status bar item
  createDeviceNameStatusBarItem(context);

  // Update status bar item once at start
  await updateStatusBarItem();

  const watcher = vscode.workspace.createFileSystemWatcher(`**/${configurationFileName}`);
  watcher.onDidCreate((_uri) => updateStatusBarItem());
  watcher.onDidChange((_uri) => updateStatusBarItem());
  watcher.onDidDelete((_uri) => updateStatusBarItem());
  context.subscriptions.push(watcher);
};

export const updateStatusBarItem = async (): Promise<void> => {
  if (!statusBarItem) {
    return;
  }

  const config = await loadConfiguration();
  const selectedDevice = getActiveDevice(config);

  statusBarItem.text = `$(circuit-board) ${selectedDevice ?? '<select device>'} [${config.baudrate}]`;
  statusBarItem.backgroundColor = selectedDevice ? undefined : new vscode.ThemeColor('statusBarItem.errorBackground');
  statusBarItem.show();
};

const createDeviceNameStatusBarItem = (context: vscode.ExtensionContext) => {
  // Register select device command handler
  context.subscriptions.push(
    vscode.commands.registerCommand(statusBarSelectCommunicationId, async () => {
      await selectSerialDevice();
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

const getActiveDevice = (config: PyboardDevConfiguration): string | undefined => {
  if (config.device && config.device.length) {
    return config.device;
  }

  const selectedFromState = extensionContext?.globalState.get<string>(selectedSerialPortStateKey);
  if (selectedFromState && selectedFromState.length) {
    return selectedFromState;
  }

  return undefined;
};

const selectSerialDevice = async (): Promise<void> => {
  let ports: Awaited<ReturnType<typeof listSerialDevices>>;
  try {
    ports = await listSerialDevices();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const msg = `Unable to list serial ports. ${reason}`;
    vscode.window.showErrorMessage(msg);
    logChannelOutput(msg, true);
    return;
  }

  if (ports.length === 0) {
    const msg = 'No serial devices found.';
    vscode.window.showWarningMessage(msg);
    logChannelOutput(msg, true);
    return;
  }

  const config = await loadConfiguration();
  const activeDevice = getActiveDevice(config);

  const items = ports.map((port) => {
    const details = [port.manufacturer, `VID:${port.vendorId}`, `PID:${port.productId}`]
      .filter(Boolean)
      .join(' | ');

    return {
      label: port.path,
      description: details,
      picked: port.path === activeDevice
    };
  });

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select a serial port for Pyboard Dev',
    canPickMany: false,
    ignoreFocusOut: true
  });

  if (!selected) {
    return;
  }

  if (!extensionContext) {
    const msg = 'Extension context not initialised. Unable to persist selected serial device.';
    vscode.window.showErrorMessage(msg);
    logChannelOutput(msg, true);
    return;
  }

  await extensionContext.globalState.update(selectedSerialPortStateKey, selected.label);

  const msg = `Selected serial device: ${selected.label}`;
  vscode.window.showInformationMessage(msg);
  logChannelOutput(msg, true);

  await updateStatusBarItem();
};
