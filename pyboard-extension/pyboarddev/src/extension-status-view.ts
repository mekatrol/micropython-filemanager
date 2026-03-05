import * as vscode from 'vscode';
import {
  getConnectedBoards,
  isBoardConnected,
  onBoardConnectionStateChanged,
  onBoardConnectionsChanged
} from './commands/connect-board-command';
import { getActiveBaudRate, getActiveDevice, getStatusDisplayMode, onStatusDataChanged } from './status-bar';

const statusViewId = 'mekatrol.pyboarddev.statusView';
const selectDeviceCommandId = 'mekatrol.pyboarddev.selectdevice';
const autoDetectDevicesCommandId = 'mekatrol.pyboarddev.autodetectdevices';
const toggleBoardConnectionCommandId = 'mekatrol.pyboarddev.toggleboardconnection';
const softRebootCommandId = 'mekatrol.pyboarddev.softreboot';

class ExtensionStatusNode extends vscode.TreeItem {
  constructor(
    label: string,
    iconId: string,
    tooltip?: string,
    command?: vscode.Command
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(iconId);
    this.tooltip = tooltip ?? label;
    this.command = command;
  }
}

class ExtensionStatusViewProvider implements vscode.TreeDataProvider<ExtensionStatusNode> {
  private readonly didChangeTreeDataEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.didChangeTreeDataEmitter.event;

  refresh(): void {
    this.didChangeTreeDataEmitter.fire();
  }

  getTreeItem(element: ExtensionStatusNode): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<ExtensionStatusNode[]> {
    if (getStatusDisplayMode() !== 'extensionView') {
      return [];
    }

    const connected = isBoardConnected();
    const selectedDevice = getActiveDevice() ?? '<select device>';
    const selectedBaudRate = getActiveBaudRate();
    const connections = getConnectedBoards();

    const items: ExtensionStatusNode[] = [];
    if (connections.length > 0) {
      items.push(new ExtensionStatusNode(`Connected Devices: ${connections.length}`, 'circuit-board'));
      for (const board of connections) {
        const runtimeSummary = board.runtimeInfo
          ? `${board.runtimeInfo.runtimeName} ${board.runtimeInfo.version}`
          : 'Reading runtime info...';
        const executing = board.executionCount > 0 ? ` | executing:${board.executionCount}` : '';
        items.push(new ExtensionStatusNode(`${board.deviceId} | ${board.devicePath} @ ${board.baudRate} | ${runtimeSummary}${executing}`, 'device-mobile'));
      }
    }

    items.push(
      new ExtensionStatusNode(
        `Serial Port: ${selectedDevice} @ ${selectedBaudRate} | [ Change ]`,
        'circuit-board',
        'Click to change selected serial port',
        { command: selectDeviceCommandId, title: 'Select serial port' }
      )
    );
    items.push(
      new ExtensionStatusNode(
        '[ Scan Devices ]',
        'search',
        'Click to enumerate serial ports (skips currently connected ports)',
        { command: autoDetectDevicesCommandId, title: 'Auto detect serial devices' }
      )
    );
    items.push(
      new ExtensionStatusNode(
        connected ? 'Board: Connected | [Disconnect ]' : 'Board: Disconnected | [ Connect ]',
        connected ? 'debug-disconnect' : 'plug',
        connected ? 'Click to disconnect one connected board' : 'Click to connect selected board',
        { command: toggleBoardConnectionCommandId, title: 'Toggle board connection' }
      )
    );

    if (connected) {
      items.push(
        new ExtensionStatusNode(
          '[ Soft Reboot Device ]',
          'debug-restart',
          'Click to soft reboot one connected device',
          { command: softRebootCommandId, title: 'Soft reboot device' }
        )
      );
    }

    return items;
  }
}

export const initExtensionStatusView = (context: vscode.ExtensionContext): void => {
  const provider = new ExtensionStatusViewProvider();
  const view = vscode.window.createTreeView(statusViewId, {
    treeDataProvider: provider,
    showCollapseAll: false
  });

  context.subscriptions.push(view);
  context.subscriptions.push(onBoardConnectionStateChanged(() => provider.refresh()));
  context.subscriptions.push(onBoardConnectionsChanged(() => provider.refresh()));
  context.subscriptions.push(onStatusDataChanged(() => provider.refresh()));
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('mekatrol.pyboarddev.statusDisplayMode')) {
        provider.refresh();
      }
    })
  );
};
