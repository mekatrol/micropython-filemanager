import * as vscode from 'vscode';
import {
  getConnectedBoardRuntimeInfo,
  isBoardConnected,
  onBoardConnectionStateChanged,
  onConnectedBoardRuntimeInfoChanged
} from './commands/connect-board-command';
import { configurationFileName } from './utils/configuration';
import { listSerialDevices } from './utils/serial-port';
import { logChannelOutput } from './output-channel';

const statusBarSelectCommunicationId = 'mekatrol.pyboarddev.selectdevice';
const statusBarToggleBoardConnectionId = 'mekatrol.pyboarddev.toggleboardconnection';
const statusBarSoftRebootId = 'mekatrol.pyboarddev.softreboot';
const statusDisplayModeSettingKey = 'statusDisplayMode';
const extensionStatusViewContextKey = 'mekatrol.pyboarddev.showExtensionStatusView';
const selectedSerialPortStateKey = 'selectedSerialPort';
const selectedBaudRateStateKey = 'selectedBaudRate';
const defaultBaudRate = 115200;
export type StatusDisplayMode = 'statusBar' | 'extensionView';
const statusDataChangedEmitter = new vscode.EventEmitter<void>();
export const onStatusDataChanged = statusDataChangedEmitter.event;

let deviceStatusBarItem: vscode.StatusBarItem | undefined = undefined;
let boardConnectionStatusBarItem: vscode.StatusBarItem | undefined = undefined;
let boardRuntimeStatusBarItem: vscode.StatusBarItem | undefined = undefined;
let softRebootStatusBarItem: vscode.StatusBarItem | undefined = undefined;
let extensionContext: vscode.ExtensionContext | undefined = undefined;

const readPersistentState = <T>(context: vscode.ExtensionContext | undefined, key: string): T | undefined => {
  if (!context) {
    return undefined;
  }

  const fromGlobal = context.globalState.get<T>(key);
  if (fromGlobal !== undefined) {
    return fromGlobal;
  }

  return context.workspaceState.get<T>(key);
};

export const initStatusBar = async (context: vscode.ExtensionContext): Promise<void> => {
  extensionContext = context;

  // Create device name status bar item
  createDeviceNameStatusBarItem(context);
  createBoardConnectionStatusBarItem(context);
  createBoardRuntimeStatusBarItem(context);
  createSoftRebootStatusBarItem(context);

  // Update status bar item once at start
  await updateStatusBarItem();

  const watcher = vscode.workspace.createFileSystemWatcher(`**/${configurationFileName}`);
  watcher.onDidCreate((_uri) => updateStatusBarItem());
  watcher.onDidChange((_uri) => updateStatusBarItem());
  watcher.onDidDelete((_uri) => updateStatusBarItem());
  context.subscriptions.push(watcher);
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(`mekatrol.pyboarddev.${statusDisplayModeSettingKey}`)) {
        void updateStatusBarItem();
      }
    })
  );
  context.subscriptions.push(onBoardConnectionStateChanged(() => updateStatusBarItem()));
  context.subscriptions.push(onConnectedBoardRuntimeInfoChanged(() => updateStatusBarItem()));
};

export const updateStatusBarItem = async (): Promise<void> => {
  if (
    !deviceStatusBarItem ||
    !boardConnectionStatusBarItem ||
    !boardRuntimeStatusBarItem ||
    !softRebootStatusBarItem
  ) {
    return;
  }

  const selectedDevice = getActiveDevice();
  const selectedBaudRate = getActiveBaudRate();
  const connected = isBoardConnected();
  const statusDisplayMode = getStatusDisplayMode();
  const showStatusBarItems = statusDisplayMode === 'statusBar';

  void vscode.commands.executeCommand('setContext', extensionStatusViewContextKey, statusDisplayMode === 'extensionView');

  if (!showStatusBarItems) {
    deviceStatusBarItem.hide();
    boardConnectionStatusBarItem.hide();
    boardRuntimeStatusBarItem.hide();
    softRebootStatusBarItem.hide();
    statusDataChangedEmitter.fire();
    return;
  }

  deviceStatusBarItem.text = `$(circuit-board) ${selectedDevice ?? '<select device>'} [${selectedBaudRate}]`;
  deviceStatusBarItem.command = connected ? undefined : statusBarSelectCommunicationId;
  deviceStatusBarItem.tooltip = connected
    ? 'Serial port selection is disabled while connected. Disconnect to change the device.'
    : 'Select serial port';
  deviceStatusBarItem.backgroundColor = selectedDevice ? undefined : new vscode.ThemeColor('statusBarItem.errorBackground');
  deviceStatusBarItem.show();

  boardConnectionStatusBarItem.text = connected ? '$(debug-disconnect) Board: Connected' : '$(plug) Board: Disconnected';
  boardConnectionStatusBarItem.tooltip = connected ? 'Disconnect from board' : 'Connect to board';
  boardConnectionStatusBarItem.backgroundColor = !connected && !selectedDevice
    ? new vscode.ThemeColor('statusBarItem.warningBackground')
    : undefined;
  boardConnectionStatusBarItem.show();

  const runtimeInfo = getConnectedBoardRuntimeInfo();
  if (connected && runtimeInfo) {
    const uniqueIdSuffix = runtimeInfo.uniqueId ? ` | UID:${runtimeInfo.uniqueId}` : '';
    const runtimeSummary = `${runtimeInfo.banner}${uniqueIdSuffix}`;
    const shortText = runtimeSummary.length > 48 ? `${runtimeSummary.slice(0, 45)}...` : runtimeSummary;
    boardRuntimeStatusBarItem.text = `$(info) ${shortText}`;
    boardRuntimeStatusBarItem.tooltip = runtimeSummary;
    boardRuntimeStatusBarItem.show();
  } else if (connected) {
    boardRuntimeStatusBarItem.text = '$(sync~spin) Reading board runtime info...';
    boardRuntimeStatusBarItem.tooltip = 'Fetching MicroPython runtime details from device';
    boardRuntimeStatusBarItem.show();
  } else {
    boardRuntimeStatusBarItem.hide();
  }

  softRebootStatusBarItem.text = '$(circuit-board) $(debug-restart)';
  softRebootStatusBarItem.tooltip = 'Soft reboot device';
  if (connected) {
    softRebootStatusBarItem.show();
  } else {
    softRebootStatusBarItem.hide();
  }

  statusDataChangedEmitter.fire();
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

const createBoardConnectionStatusBarItem = (context: vscode.ExtensionContext) => {
  boardConnectionStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  boardConnectionStatusBarItem.command = statusBarToggleBoardConnectionId;
  context.subscriptions.push(boardConnectionStatusBarItem);
};

const createBoardRuntimeStatusBarItem = (context: vscode.ExtensionContext) => {
  boardRuntimeStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
  context.subscriptions.push(boardRuntimeStatusBarItem);
};

const createSoftRebootStatusBarItem = (context: vscode.ExtensionContext) => {
  softRebootStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 97);
  softRebootStatusBarItem.command = statusBarSoftRebootId;
  context.subscriptions.push(softRebootStatusBarItem);
};

export const getActiveDevice = (): string | undefined => {
  const selectedFromState = readPersistentState<string>(extensionContext, selectedSerialPortStateKey);
  if (selectedFromState && selectedFromState.length) {
    return selectedFromState;
  }

  return undefined;
};

export const getActiveBaudRate = (): number => {
  return readPersistentState<number>(extensionContext, selectedBaudRateStateKey) ?? defaultBaudRate;
};

export const getActivePythonType = (): 'MicroPython' | 'CircuitPython' | 'Unknown' => {
  const runtimeInfo = getConnectedBoardRuntimeInfo();
  if (!runtimeInfo) {
    return 'Unknown';
  }
  return runtimeInfo.runtimeName;
};

export const getStatusDisplayMode = (): StatusDisplayMode => {
  const value = vscode.workspace.getConfiguration('mekatrol.pyboarddev').get<string>(statusDisplayModeSettingKey, 'statusBar');
  return value === 'extensionView' ? 'extensionView' : 'statusBar';
};

const selectSerialDevice = async (): Promise<void> => {
  if (isBoardConnected()) {
    const msg = 'Disconnect from the board before selecting a different serial port.';
    vscode.window.showWarningMessage(msg);
    logChannelOutput(msg, true);
    return;
  }

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

  if (isBoardConnected()) {
    const msg = 'Board connected while selecting serial port. Disconnect before changing the selected device.';
    vscode.window.showWarningMessage(msg);
    logChannelOutput(msg, true);
    return;
  }

  if (!extensionContext) {
    const msg = 'Extension context not initialised. Unable to persist selected serial device.';
    vscode.window.showErrorMessage(msg);
    logChannelOutput(msg, true);
    return;
  }

  await extensionContext.globalState.update(selectedSerialPortStateKey, selected.label);
  await extensionContext.workspaceState.update(selectedSerialPortStateKey, selected.label);
  await extensionContext.globalState.update(selectedBaudRateStateKey, getActiveBaudRate());
  await extensionContext.workspaceState.update(selectedBaudRateStateKey, getActiveBaudRate());

  const msg = `Selected serial device: ${selected.label}`;
  vscode.window.showInformationMessage(msg);
  logChannelOutput(msg, true);

  await updateStatusBarItem();
};
