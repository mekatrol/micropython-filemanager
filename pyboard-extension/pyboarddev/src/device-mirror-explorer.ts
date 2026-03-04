import { Buffer } from 'buffer';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getConnectedBoard, onBoardConnectionStateChanged } from './commands/connect-board-command';
import { logChannelOutput } from './output-channel';
import { loadConfiguration } from './utils/configuration';
import {
  FileEntry,
  SyncState,
  buildSyncStateMap,
  listDeviceEntries,
  normaliseObfuscationSet,
  readDeviceFile,
  resolveMirrorRootPath,
  scanLocalMirrorEntries,
  toRelativePath,
  writeDeviceFile
} from './utils/device-filesystem';

const viewId = 'mekatrol.pyboarddev.deviceMirrorExplorer';
const commandRefreshId = 'mekatrol.pyboarddev.refreshmirrorview';
const commandSyncFromDeviceId = 'mekatrol.pyboarddev.syncfromdevice';
const commandSyncToDeviceId = 'mekatrol.pyboarddev.synctodevice';
const commandOpenLocalItemId = 'mekatrol.pyboarddev.openlocalmirroritem';
const commandPullAndOpenDeviceItemId = 'mekatrol.pyboarddev.pullandopendeviceitem';

const obfuscatedPlaceholder = '# pyboarddev: obfuscated on pull\n';

type NodeSide = 'device' | 'local';

interface NodeData {
  side: NodeSide;
  relativePath: string;
  isDirectory: boolean;
  isRoot: boolean;
}

class MirrorNode extends vscode.TreeItem {
  public readonly data: NodeData;

  constructor(data: NodeData, label: string, collapsibleState: vscode.TreeItemCollapsibleState) {
    super(label, collapsibleState);
    this.data = data;
  }
}

class DeviceMirrorTreeProvider implements vscode.TreeDataProvider<MirrorNode>, vscode.Disposable {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<MirrorNode | undefined>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private workspaceFolder: vscode.WorkspaceFolder | undefined;
  private mirrorRootPath: string | undefined;
  private obfuscationSet: Set<string> = new Set();

  private localEntries: FileEntry[] = [{ relativePath: '', isDirectory: true }];
  private deviceEntries: FileEntry[] = [{ relativePath: '', isDirectory: true }];
  private syncStates: Map<string, SyncState> = new Map();

  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {
    this.disposables.push(onBoardConnectionStateChanged(() => this.refresh()));
    this.disposables.push(vscode.workspace.onDidSaveTextDocument((document) => this.handlePossibleMirrorFileSave(document.uri.fsPath)));
    this.disposables.push(vscode.workspace.onDidDeleteFiles((event) => event.files.forEach((uri) => this.handlePossibleMirrorFileSave(uri.fsPath))));
    this.disposables.push(vscode.workspace.onDidCreateFiles((event) => event.files.forEach((uri) => this.handlePossibleMirrorFileSave(uri.fsPath))));
  }

  dispose(): void {
    this.onDidChangeTreeDataEmitter.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  async refresh(fetchDevice: boolean = true): Promise<void> {
    this.workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!this.workspaceFolder) {
      this.localEntries = [{ relativePath: '', isDirectory: true }];
      this.deviceEntries = [{ relativePath: '', isDirectory: true }];
      this.syncStates = new Map();
      this.onDidChangeTreeDataEmitter.fire(undefined);
      return;
    }

    const config = await loadConfiguration();
    this.obfuscationSet = normaliseObfuscationSet(config.obfuscateOnPull ?? []);
    this.mirrorRootPath = await resolveMirrorRootPath(this.workspaceFolder, config.mirrorFolder);

    this.localEntries = await scanLocalMirrorEntries(this.mirrorRootPath);

    if (fetchDevice) {
      const board = getConnectedBoard();
      if (!board) {
        this.deviceEntries = [{ relativePath: '', isDirectory: true }];
      } else {
        try {
          this.deviceEntries = await listDeviceEntries(board);
        } catch (error) {
          this.deviceEntries = [{ relativePath: '', isDirectory: true }];
          const message = error instanceof Error ? error.message : String(error);
          logChannelOutput(`Unable to read device filesystem: ${message}`, true);
        }
      }
    }

    this.syncStates = buildSyncStateMap(this.localEntries, this.deviceEntries, this.obfuscationSet);
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  async syncFromDevice(): Promise<void> {
    if (!this.workspaceFolder || !this.mirrorRootPath) {
      await this.refresh(false);
    }

    const board = getConnectedBoard();
    if (!board) {
      vscode.window.showWarningMessage('Connect to a board before syncing from device.');
      return;
    }

    if (!this.mirrorRootPath) {
      vscode.window.showWarningMessage('Open a workspace before syncing from device.');
      return;
    }

    const deviceEntries = await listDeviceEntries(board);

    for (const entry of deviceEntries) {
      if (entry.relativePath.length === 0) {
        continue;
      }

      const localPath = path.join(this.mirrorRootPath, entry.relativePath);
      if (entry.isDirectory) {
        await fs.mkdir(localPath, { recursive: true });
        continue;
      }

      await fs.mkdir(path.dirname(localPath), { recursive: true });
      if (this.obfuscationSet.has(entry.relativePath)) {
        await fs.writeFile(localPath, obfuscatedPlaceholder, 'utf8');
        continue;
      }

      const content = await readDeviceFile(board, entry.relativePath);
      await fs.writeFile(localPath, content);
    }

    this.deviceEntries = deviceEntries;
    this.localEntries = await scanLocalMirrorEntries(this.mirrorRootPath);
    this.syncStates = buildSyncStateMap(this.localEntries, this.deviceEntries, this.obfuscationSet);
    this.onDidChangeTreeDataEmitter.fire(undefined);

    const msg = 'Sync from device complete.';
    vscode.window.showInformationMessage(msg);
    logChannelOutput(msg, true);
  }

  async syncToDevice(): Promise<void> {
    if (!this.workspaceFolder || !this.mirrorRootPath) {
      await this.refresh(false);
    }

    const board = getConnectedBoard();
    if (!board) {
      vscode.window.showWarningMessage('Connect to a board before syncing to device.');
      return;
    }

    if (!this.mirrorRootPath) {
      vscode.window.showWarningMessage('Open a workspace before syncing to device.');
      return;
    }

    const localEntries = await scanLocalMirrorEntries(this.mirrorRootPath);
    for (const entry of localEntries) {
      if (entry.isDirectory || entry.relativePath.length === 0) {
        continue;
      }

      if (this.obfuscationSet.has(entry.relativePath)) {
        logChannelOutput(`Skipping obfuscated file during sync to device: ${entry.relativePath}`, false);
        continue;
      }

      const localPath = path.join(this.mirrorRootPath, entry.relativePath);
      const content = await fs.readFile(localPath);
      await writeDeviceFile(board, entry.relativePath, Buffer.from(content));
    }

    this.localEntries = localEntries;
    this.deviceEntries = await listDeviceEntries(board);
    this.syncStates = buildSyncStateMap(this.localEntries, this.deviceEntries, this.obfuscationSet);
    this.onDidChangeTreeDataEmitter.fire(undefined);

    const msg = 'Sync to device complete.';
    vscode.window.showInformationMessage(msg);
    logChannelOutput(msg, true);
  }

  async openLocalNode(node: MirrorNode): Promise<void> {
    if (!this.mirrorRootPath) {
      return;
    }

    const fullPath = path.join(this.mirrorRootPath, node.data.relativePath);
    const stat = await fs.stat(fullPath);
    if (stat.isDirectory()) {
      return;
    }

    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(fullPath));
    await vscode.window.showTextDocument(document, { preview: false });
  }

  async pullDeviceNodeAndOpen(node: MirrorNode): Promise<void> {
    const board = getConnectedBoard();
    if (!board) {
      vscode.window.showWarningMessage('Connect to a board before opening a device file.');
      return;
    }

    if (!this.mirrorRootPath) {
      await this.refresh(false);
    }

    if (!this.mirrorRootPath) {
      return;
    }

    if (node.data.isDirectory) {
      return;
    }

    const relativePath = node.data.relativePath;
    const localPath = path.join(this.mirrorRootPath, relativePath);
    await fs.mkdir(path.dirname(localPath), { recursive: true });

    if (this.obfuscationSet.has(relativePath)) {
      await fs.writeFile(localPath, obfuscatedPlaceholder, 'utf8');
    } else {
      const content = await readDeviceFile(board, relativePath);
      await fs.writeFile(localPath, content);
    }

    await this.refresh();
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(localPath));
    await vscode.window.showTextDocument(document, { preview: false });
  }

  getTreeItem(element: MirrorNode): vscode.TreeItem {
    const { data } = element;

    if (data.isRoot) {
      if (data.side === 'device') {
        const connected = getConnectedBoard() !== undefined;
        element.description = connected ? 'connected' : 'disconnected';
        element.iconPath = new vscode.ThemeIcon('plug');
        element.contextValue = 'pyboarddev.deviceRoot';
      } else {
        element.description = this.mirrorRootPath ? path.basename(this.mirrorRootPath) : 'no workspace';
        element.iconPath = new vscode.ThemeIcon('folder-library');
        element.contextValue = 'pyboarddev.localRoot';
      }

      return element;
    }

    element.contextValue = data.side === 'device' ? 'pyboarddev.deviceNode' : 'pyboarddev.localNode';
    element.iconPath = data.isDirectory ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;

    if (!data.isDirectory) {
      const sync = this.syncStates.get(data.relativePath);
      switch (sync) {
        case 'synced':
          element.description = 'synced';
          break;
        case 'out_of_sync':
          element.description = 'out-of-sync';
          break;
        case 'device_only':
          element.description = data.side === 'device' ? 'device only' : 'missing on device';
          break;
        case 'local_only':
          element.description = data.side === 'local' ? 'local only' : 'missing in mirror';
          break;
        case 'obfuscated':
          element.description = 'obfuscated';
          break;
        default:
          element.description = undefined;
      }
    }

    if (!data.isDirectory && data.side === 'local') {
      element.command = {
        command: commandOpenLocalItemId,
        title: 'Open local mirror file',
        arguments: [element]
      };
    }

    if (!data.isDirectory && data.side === 'device') {
      element.command = {
        command: commandPullAndOpenDeviceItemId,
        title: 'Pull and open device file',
        arguments: [element]
      };
    }

    return element;
  }

  getChildren(element?: MirrorNode): MirrorNode[] {
    if (!element) {
      return [
        new MirrorNode({ side: 'device', relativePath: '', isDirectory: true, isRoot: true }, 'Device', vscode.TreeItemCollapsibleState.Expanded),
        new MirrorNode({ side: 'local', relativePath: '', isDirectory: true, isRoot: true }, 'Mirror', vscode.TreeItemCollapsibleState.Expanded)
      ];
    }

    if (!element.data.isDirectory) {
      return [];
    }

    const sourceEntries = element.data.side === 'device' ? this.deviceEntries : this.localEntries;
    const parentPath = element.data.relativePath;
    const children = this.findDirectChildren(sourceEntries, parentPath, element.data.side);

    return children.sort((a, b) => {
      if (a.data.isDirectory !== b.data.isDirectory) {
        return a.data.isDirectory ? -1 : 1;
      }

      return a.label!.toString().localeCompare(b.label!.toString());
    });
  }

  private findDirectChildren(entries: FileEntry[], parentRelativePath: string, side: NodeSide): MirrorNode[] {
    const nodes: MirrorNode[] = [];

    for (const entry of entries) {
      if (entry.relativePath.length === 0) {
        continue;
      }

      const parent = path.posix.dirname(entry.relativePath);
      const directParent = parent === '.' ? '' : toRelativePath(parent);
      if (directParent !== parentRelativePath) {
        continue;
      }

      const name = path.posix.basename(entry.relativePath);
      nodes.push(
        new MirrorNode(
          {
            side,
            relativePath: entry.relativePath,
            isDirectory: entry.isDirectory,
            isRoot: false
          },
          name,
          entry.isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
        )
      );
    }

    return nodes;
  }

  private async handlePossibleMirrorFileSave(fsPath: string): Promise<void> {
    if (!this.mirrorRootPath) {
      return;
    }

    const normalised = toRelativePath(path.relative(this.mirrorRootPath, fsPath));
    if (normalised.startsWith('..')) {
      return;
    }

    await this.refresh(false);
  }
}

export const initDeviceMirrorExplorer = async (context: vscode.ExtensionContext): Promise<void> => {
  const provider = new DeviceMirrorTreeProvider(context);

  context.subscriptions.push(provider);
  context.subscriptions.push(vscode.window.registerTreeDataProvider(viewId, provider));

  context.subscriptions.push(
    vscode.commands.registerCommand(commandRefreshId, async () => provider.refresh(true))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(commandSyncFromDeviceId, async () => provider.syncFromDevice())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(commandSyncToDeviceId, async () => provider.syncToDevice())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(commandOpenLocalItemId, async (node: MirrorNode) => provider.openLocalNode(node))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(commandPullAndOpenDeviceItemId, async (node: MirrorNode) => provider.pullDeviceNodeAndOpen(node))
  );

  await provider.refresh();
};
