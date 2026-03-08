/**
 * Module overview:
 * Provides the sidebar status tree that shows connection summary and
 * exposes quick status actions.
 */
import * as vscode from 'vscode';
import {
  getConnectedPyDevices,
  onBoardConnectionStateChanged,
  onBoardConnectionsChanged
} from '../commands/connect-board-command';

const statusViewId = 'mekatrol.pydevice.statusView';
const softRebootCommandId = 'mekatrol.pydevice.softreboot';

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
    const connections = getConnectedPyDevices();

    const items: ExtensionStatusNode[] = [];
    items.push(new ExtensionStatusNode(`Connected Devices: ${connections.length}`, 'circuit-board'));

    if (connections.length > 0) {
      items.push(
        new ExtensionStatusNode(
          '[ Soft Reboot Device ]',
          'debug-restart',
          'Click to soft reboot one connected device',
          { command: softRebootCommandId, title: vscode.l10n.t('Soft reboot device') }
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
};
