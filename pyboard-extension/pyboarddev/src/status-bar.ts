/**
 * Module overview:
 * This file is part of the Pyboard extension runtime and contains
 * feature-specific logic isolated for maintainability and unit testing.
 */
import * as vscode from 'vscode';
import {
  getConnectedBoards,
  isBoardConnected,
  onBoardConnectionStateChanged,
  onBoardConnectionsChanged
} from './commands/connect-board-command';
import { configurationFileName } from './utils/configuration';
import { listSerialDevices } from './utils/serial-port';
import { logChannelOutput } from './output-channel';

const statusBarSelectCommunicationId = 'mekatrol.pyboarddev.selectdevice';
const statusBarToggleBoardConnectionId = 'mekatrol.pyboarddev.toggleboardconnection';
const statusBarSoftRebootId = 'mekatrol.pyboarddev.softreboot';
const statusDisplayModeSettingKey = 'statusDisplayMode';
const extensionStatusViewContextKey = 'mekatrol.pyboarddev.showExtensionStatusView';
const defaultBaudRate = 115200;
export type StatusDisplayMode = 'statusBar' | 'extensionView';
const statusDataChangedEmitter = new vscode.EventEmitter<void>();
export const onStatusDataChanged = statusDataChangedEmitter.event;

let deviceStatusBarItem: vscode.StatusBarItem | undefined = undefined;
let boardConnectionStatusBarItem: vscode.StatusBarItem | undefined = undefined;
let boardRuntimeStatusBarItem: vscode.StatusBarItem | undefined = undefined;
let softRebootStatusBarItem: vscode.StatusBarItem | undefined = undefined;

export const initStatusBar = async (context: vscode.ExtensionContext): Promise<void> => {
  createDeviceNameStatusBarItem(context);
  createBoardConnectionStatusBarItem(context);
  createBoardRuntimeStatusBarItem(context);
  createSoftRebootStatusBarItem(context);

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
  context.subscriptions.push(onBoardConnectionsChanged(() => updateStatusBarItem()));
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
  const connectedBoards = getConnectedBoards();

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
  deviceStatusBarItem.command = statusBarSelectCommunicationId;
  deviceStatusBarItem.tooltip = 'Select serial port';
  deviceStatusBarItem.backgroundColor = selectedDevice ? undefined : new vscode.ThemeColor('statusBarItem.errorBackground');
  deviceStatusBarItem.show();

  boardConnectionStatusBarItem.text = connected
    ? `$(plug) Boards: ${connectedBoards.length} Connected`
    : '$(plug) Board: Disconnected';
  boardConnectionStatusBarItem.tooltip = connected
    ? 'Manage boards (connect another or disconnect one)'
    : 'Connect selected board';
  boardConnectionStatusBarItem.backgroundColor = !connected && !selectedDevice
    ? new vscode.ThemeColor('statusBarItem.warningBackground')
    : undefined;
  boardConnectionStatusBarItem.show();

  if (connectedBoards.length > 0) {
    const summary = connectedBoards
      .map((board) => {
        const runtime = board.runtimeInfo ? `${board.runtimeInfo.runtimeName} ${board.runtimeInfo.version}` : 'probing';
        const executing = board.executionCount > 0 ? ` exec:${board.executionCount}` : '';
        return `${board.deviceId} (${runtime}${executing})`;
      })
      .join(' | ');
    const shortText = summary.length > 60 ? `${summary.slice(0, 57)}...` : summary;
    boardRuntimeStatusBarItem.text = `$(info) ${shortText}`;
    boardRuntimeStatusBarItem.tooltip = summary;
    boardRuntimeStatusBarItem.show();
  } else {
    boardRuntimeStatusBarItem.hide();
  }

  softRebootStatusBarItem.text = '$(circuit-board) $(debug-restart)';
  softRebootStatusBarItem.tooltip = 'Soft reboot one connected device';
  if (connected) {
    softRebootStatusBarItem.show();
  } else {
    softRebootStatusBarItem.hide();
  }

  statusDataChangedEmitter.fire();
};

const createDeviceNameStatusBarItem = (context: vscode.ExtensionContext) => {
  context.subscriptions.push(
    vscode.commands.registerCommand(statusBarSelectCommunicationId, async () => {
      await selectSerialDevice();
    })
  );

  deviceStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  deviceStatusBarItem.command = statusBarSelectCommunicationId;
  context.subscriptions.push(deviceStatusBarItem);

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
  const active = getConnectedBoards()[0];
  if (active?.devicePath && active.devicePath.length > 0) {
    return active.devicePath;
  }

  return undefined;
};

export const getActiveBaudRate = (): number => {
  return getConnectedBoards()[0]?.baudRate ?? defaultBaudRate;
};

export const getActivePythonType = (): 'MicroPython' | 'CircuitPython' | 'Unknown' => {
  const active = getConnectedBoards()[0];
  if (!active?.runtimeInfo) {
    return 'Unknown';
  }
  return active.runtimeInfo.runtimeName;
};

export const getStatusDisplayMode = (): StatusDisplayMode => {
  const value = vscode.workspace.getConfiguration('mekatrol.pyboarddev').get<string>(statusDisplayModeSettingKey, 'statusBar');
  return value === 'extensionView' ? 'extensionView' : 'statusBar';
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

  await vscode.commands.executeCommand('mekatrol.pyboarddev.connectboard', { devicePath: selected.label });

  const msg = `Selected serial device: ${selected.label}`;
  logChannelOutput(msg, true);

  await updateStatusBarItem();
};
