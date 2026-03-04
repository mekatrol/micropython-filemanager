import * as vscode from 'vscode';
import { isBoardConnected, onBoardConnectionStateChanged } from './commands/connect-board-command';
import { configurationFileName, loadConfiguration } from './utils/configuration';
import { listSerialDevices } from './utils/serial-port';
import { logChannelOutput } from './output-channel';

const statusBarSelectCommunicationId = 'mekatrol.pyboarddev.selectdevice';
const statusBarSelectPythonTypeId = 'mekatrol.pyboarddev.selectpythontype';
const statusBarToggleBoardConnectionId = 'mekatrol.pyboarddev.toggleboardconnection';
const selectedSerialPortStateKey = 'selectedSerialPort';
const selectedBaudRateStateKey = 'selectedBaudRate';
const selectedPythonTypeStateKey = 'selectedPythonType';
const defaultBaudRate = 115200;
const pythonTypes = ['MicroPython', 'CircuitPython'] as const;
type PythonType = typeof pythonTypes[number];

let deviceStatusBarItem: vscode.StatusBarItem | undefined = undefined;
let pythonTypeStatusBarItem: vscode.StatusBarItem | undefined = undefined;
let boardConnectionStatusBarItem: vscode.StatusBarItem | undefined = undefined;
let extensionContext: vscode.ExtensionContext | undefined = undefined;

export const initStatusBar = async (context: vscode.ExtensionContext): Promise<void> => {
  extensionContext = context;

  // Create device name status bar item
  createDeviceNameStatusBarItem(context);
  createPythonTypeStatusBarItem(context);
  createBoardConnectionStatusBarItem(context);

  // Update status bar item once at start
  await updateStatusBarItem();

  const watcher = vscode.workspace.createFileSystemWatcher(`**/${configurationFileName}`);
  watcher.onDidCreate((_uri) => updateStatusBarItem());
  watcher.onDidChange((_uri) => updateStatusBarItem());
  watcher.onDidDelete((_uri) => updateStatusBarItem());
  context.subscriptions.push(watcher);
  context.subscriptions.push(onBoardConnectionStateChanged(() => updateStatusBarItem()));
};

export const updateStatusBarItem = async (): Promise<void> => {
  if (!deviceStatusBarItem || !pythonTypeStatusBarItem || !boardConnectionStatusBarItem) {
    return;
  }

  const selectedDevice = getActiveDevice();
  const selectedBaudRate = getActiveBaudRate();
  const selectedPythonType = await getActivePythonType();
  const connected = isBoardConnected();

  deviceStatusBarItem.text = `$(circuit-board) ${selectedDevice ?? '<select device>'} [${selectedBaudRate}]`;
  deviceStatusBarItem.backgroundColor = selectedDevice ? undefined : new vscode.ThemeColor('statusBarItem.errorBackground');
  deviceStatusBarItem.show();

  pythonTypeStatusBarItem.text = `$(symbol-class) ${selectedPythonType}`;
  pythonTypeStatusBarItem.show();

  boardConnectionStatusBarItem.text = connected ? '$(debug-disconnect) Board: Connected' : '$(plug) Board: Disconnected';
  boardConnectionStatusBarItem.tooltip = connected ? 'Disconnect from board' : 'Connect to board';
  boardConnectionStatusBarItem.backgroundColor = !connected && !selectedDevice
    ? new vscode.ThemeColor('statusBarItem.warningBackground')
    : undefined;
  boardConnectionStatusBarItem.show();
};

const createDeviceNameStatusBarItem = (context: vscode.ExtensionContext) => {
  // Register select device command handler
  context.subscriptions.push(
    vscode.commands.registerCommand(statusBarSelectCommunicationId, async () => {
      await selectSerialDevice();
    })
  );

  // Create select device status bar item
  deviceStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  deviceStatusBarItem.command = statusBarSelectCommunicationId;
  context.subscriptions.push(deviceStatusBarItem);

  // Register listeners for file updates
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(updateStatusBarItem));
  context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection(updateStatusBarItem));
};

const createPythonTypeStatusBarItem = (context: vscode.ExtensionContext) => {
  context.subscriptions.push(
    vscode.commands.registerCommand(statusBarSelectPythonTypeId, async () => {
      await selectPythonType();
    })
  );

  pythonTypeStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  pythonTypeStatusBarItem.command = statusBarSelectPythonTypeId;
  context.subscriptions.push(pythonTypeStatusBarItem);
};

const createBoardConnectionStatusBarItem = (context: vscode.ExtensionContext) => {
  boardConnectionStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
  boardConnectionStatusBarItem.command = statusBarToggleBoardConnectionId;
  context.subscriptions.push(boardConnectionStatusBarItem);
};

const getActiveDevice = (): string | undefined => {
  const selectedFromState = extensionContext?.workspaceState.get<string>(selectedSerialPortStateKey);
  if (selectedFromState && selectedFromState.length) {
    return selectedFromState;
  }

  return undefined;
};

const getActiveBaudRate = (): number => {
  return extensionContext?.workspaceState.get<number>(selectedBaudRateStateKey) ?? defaultBaudRate;
};

const isPythonType = (value: string): value is PythonType => {
  return pythonTypes.includes(value as PythonType);
};

const getActivePythonType = async (): Promise<PythonType> => {
  const selectedFromState = extensionContext?.workspaceState.get<string>(selectedPythonTypeStateKey);
  if (selectedFromState && isPythonType(selectedFromState)) {
    return selectedFromState;
  }

  const config = await loadConfiguration();
  if (config.pythonType && isPythonType(config.pythonType)) {
    return config.pythonType;
  }

  return 'MicroPython';
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

  const activeDevice = getActiveDevice();

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

  await extensionContext.workspaceState.update(selectedSerialPortStateKey, selected.label);
  await extensionContext.workspaceState.update(selectedBaudRateStateKey, getActiveBaudRate());

  const msg = `Selected serial device: ${selected.label}`;
  vscode.window.showInformationMessage(msg);
  logChannelOutput(msg, true);

  await updateStatusBarItem();
};

const selectPythonType = async (): Promise<void> => {
  const activePythonType = await getActivePythonType();
  const items = pythonTypes.map((type) => ({
    label: type,
    picked: type === activePythonType
  }));

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select Python type for Pyboard Dev',
    canPickMany: false,
    ignoreFocusOut: true
  });

  if (!selected) {
    return;
  }

  if (!extensionContext) {
    const msg = 'Extension context not initialised. Unable to persist selected python type.';
    vscode.window.showErrorMessage(msg);
    logChannelOutput(msg, true);
    return;
  }

  await extensionContext.workspaceState.update(selectedPythonTypeStateKey, selected.label);

  const msg = `Selected python type: ${selected.label}`;
  vscode.window.showInformationMessage(msg);
  logChannelOutput(msg, true);

  await updateStatusBarItem();
};
