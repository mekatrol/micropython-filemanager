import * as vscode from 'vscode';
import { getConnectedBoardRuntimeInfo, isBoardConnected, onBoardConnectionStateChanged, onConnectedBoardRuntimeInfoChanged } from './commands/connect-board-command';
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

    const items: ExtensionStatusNode[] = [];
    if (connected) {
      const runtimeInfo = getConnectedBoardRuntimeInfo();
      if (runtimeInfo) {
        items.push(new ExtensionStatusNode(`Runtime: ${runtimeInfo.runtimeName} ${runtimeInfo.version}`, 'info'));
        items.push(new ExtensionStatusNode(`Device: ${runtimeInfo.machine}`, 'info'));
        items.push(new ExtensionStatusNode(`Unique ID: ${runtimeInfo.uniqueId ?? '<not available>'}`, 'info'));
      } else {
        items.push(new ExtensionStatusNode('Runtime: Reading board runtime info...', 'sync~spin'));
        items.push(new ExtensionStatusNode('Device: Reading board details...', 'sync~spin'));
        items.push(new ExtensionStatusNode('Unique ID: Reading board details...', 'sync~spin'));
      }
    }

    items.push(
      new ExtensionStatusNode(
        connected
          ? `Serial Port: ${selectedDevice} @ ${selectedBaudRate}`
          : `Serial Port: ${selectedDevice} @ ${selectedBaudRate} | [ Change ]`,
        'circuit-board',
        connected ? 'Disconnect board first, then change serial port' : 'Click to change serial port',
        connected ? undefined : { command: selectDeviceCommandId, title: 'Select serial port' }
      )
    );
    items.push(
      new ExtensionStatusNode(
        connected ? 'Disconnect to scan devices...' : '[ Scan Devices ]',
        'search',
        connected ? 'Disconnect board first, then enumerate serial ports' : 'Click to enumerate serial ports',
        connected ? undefined : { command: autoDetectDevicesCommandId, title: 'Auto detect serial devices' }
      )
    );
    items.push(
      new ExtensionStatusNode(
        connected ? 'Board: Connected | [Disconnect ]' : 'Board: Disconnected | [ Connect ]',
        connected ? 'debug-disconnect' : 'plug',
        connected ? 'Click to disconnect from board' : 'Click to connect to board',
        { command: toggleBoardConnectionCommandId, title: 'Toggle board connection' }
      )
    );

    if (connected) {
      items.push(
        new ExtensionStatusNode(
          '[ Soft Reboot Device ]',
          'debug-restart',
          'Click to terminate debug (if active) and soft reboot the device',
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
  context.subscriptions.push(onConnectedBoardRuntimeInfoChanged(() => provider.refresh()));
  context.subscriptions.push(onStatusDataChanged(() => provider.refresh()));
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('mekatrol.pyboarddev.statusDisplayMode')) {
        provider.refresh();
      }
    })
  );
};
