import { Buffer } from 'buffer';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getConnectedBoard, onBoardConnectionStateChanged } from './commands/connect-board-command';
import { logChannelOutput } from './output-channel';
import { onPythonTypeChanged } from './status-bar';
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

const localViewId = 'mekatrol.pyboarddev.localMirrorExplorer';
const deviceViewId = 'mekatrol.pyboarddev.deviceFilesystemExplorer';
const commandRefreshId = 'mekatrol.pyboarddev.refreshmirrorview';
const commandSyncFromDeviceId = 'mekatrol.pyboarddev.syncfromdevice';
const commandSyncToDeviceId = 'mekatrol.pyboarddev.synctodevice';
const commandOpenLocalItemId = 'mekatrol.pyboarddev.openlocalmirroritem';
const commandPullAndOpenDeviceItemId = 'mekatrol.pyboarddev.pullandopendeviceitem';
const commandOpenRemoteFileId = 'mekatrol.pyboarddev.openremotefile';
const remoteDocumentScheme = 'pyboarddev-remote';
const selectedPythonTypeStateKey = 'selectedPythonType';

const obfuscatedPlaceholder = '# pyboarddev: obfuscated on pull\n';

type NodeSide = 'device' | 'local';

interface NodeData {
  side: NodeSide;
  relativePath: string;
  isDirectory: boolean;
  isIndicator?: boolean;
}

class MirrorNode extends vscode.TreeItem {
  public readonly data: NodeData;

  constructor(data: NodeData, label: string, collapsibleState: vscode.TreeItemCollapsibleState) {
    super(label, collapsibleState);
    this.data = data;
  }
}

class DeviceMirrorModel {
  private readonly onDidChangeDataEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeData = this.onDidChangeDataEmitter.event;

  private workspaceFolder: vscode.WorkspaceFolder | undefined;
  private mirrorRootPath: string | undefined;
  private obfuscationSet: Set<string> = new Set();
  private pythonType = 'MicroPython';

  private localEntries: FileEntry[] = [{ relativePath: '', isDirectory: true }];
  private deviceEntries: FileEntry[] = [{ relativePath: '', isDirectory: true }];
  private syncStates: Map<string, SyncState> = new Map();

  constructor(private readonly context: vscode.ExtensionContext) {}

  private normalisePythonType(value: string | undefined): 'MicroPython' | 'CircuitPython' {
    const lowered = (value ?? '').toLowerCase();
    if (lowered === 'circuitpython') {
      return 'CircuitPython';
    }

    return 'MicroPython';
  }

  async refresh(fetchDevice: boolean = true): Promise<void> {
    this.workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!this.workspaceFolder) {
      this.localEntries = [{ relativePath: '', isDirectory: true }];
      this.deviceEntries = [{ relativePath: '', isDirectory: true }];
      this.syncStates = new Map();
      this.onDidChangeDataEmitter.fire();
      return;
    }

    const config = await loadConfiguration();
    this.obfuscationSet = normaliseObfuscationSet(config.obfuscateOnPull ?? []);
    const selectedPythonType = this.context.workspaceState.get<string>(selectedPythonTypeStateKey);
    this.pythonType = this.normalisePythonType(selectedPythonType || config.pythonType);
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
    this.onDidChangeDataEmitter.fire();
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
    this.onDidChangeDataEmitter.fire();

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
    this.onDidChangeDataEmitter.fire();

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
    if (!getConnectedBoard()) {
      vscode.window.showWarningMessage('Connect to a board before opening a device file.');
      return;
    }

    if (!this.mirrorRootPath) {
      await this.refresh(false);
    }

    if (!this.mirrorRootPath || node.data.isDirectory) {
      return;
    }

    const relativePath = toRelativePath(node.data.relativePath);
    const remoteUri = vscode.Uri.parse(`${remoteDocumentScheme}:/${relativePath}`);
    const document = await vscode.workspace.openTextDocument(remoteUri);
    await vscode.window.showTextDocument(document, { preview: false });
  }

  async openRemoteFile(node?: MirrorNode): Promise<void> {
    if (node) {
      await this.pullDeviceNodeAndOpen(node);
      return;
    }

    const board = getConnectedBoard();
    if (!board) {
      vscode.window.showWarningMessage('Connect to a board before opening a remote file.');
      return;
    }

    const files = this.deviceEntries
      .filter((entry) => !entry.isDirectory && entry.relativePath.length > 0)
      .sort((a, b) => a.relativePath.localeCompare(b.relativePath));

    if (files.length === 0) {
      vscode.window.showInformationMessage('No remote files available to open.');
      return;
    }

    const selected = await vscode.window.showQuickPick(
      files.map((item) => ({ label: item.relativePath })),
      {
        placeHolder: 'Select a remote file to open',
        canPickMany: false,
        ignoreFocusOut: true
      }
    );

    if (!selected) {
      return;
    }

    const quickPickNode = new MirrorNode(
      {
        side: 'device',
        relativePath: selected.label,
        isDirectory: false
      },
      selected.label,
      vscode.TreeItemCollapsibleState.None
    );

    await this.pullDeviceNodeAndOpen(quickPickNode);
  }

  getNodeChildren(side: NodeSide, parentRelativePath: string): MirrorNode[] {
    const sourceEntries = side === 'device' ? this.deviceEntries : this.localEntries;
    const nodes: MirrorNode[] = [];

    for (const entry of sourceEntries) {
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
            isDirectory: entry.isDirectory
          },
          name,
          entry.isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
        )
      );
    }

    return nodes.sort((a, b) => {
      if (a.data.isDirectory !== b.data.isDirectory) {
        return a.data.isDirectory ? -1 : 1;
      }

      return a.label!.toString().localeCompare(b.label!.toString());
    });
  }

  getSyncState(relativePath: string): SyncState | undefined {
    return this.syncStates.get(relativePath);
  }

  isBoardConnected(): boolean {
    return getConnectedBoard() !== undefined;
  }

  private toMirrorRelativePath(fsPath: string): string | undefined {
    if (!this.mirrorRootPath) {
      return undefined;
    }

    const normalised = toRelativePath(path.relative(this.mirrorRootPath, fsPath));
    if (normalised.startsWith('..')) {
      return undefined;
    }

    return normalised;
  }

  async handleDocumentSaved(document: vscode.TextDocument): Promise<void> {
    if (document.uri.scheme === remoteDocumentScheme) {
      await this.refresh(true);
      return;
    }

    if (document.uri.scheme === 'file') {
      const relativePath = this.toMirrorRelativePath(document.uri.fsPath);
      if (!relativePath) {
        return;
      }

      await this.refresh(false);
    }
  }

  async handlePossibleMirrorFileChange(fsPath: string): Promise<void> {
    if (!this.toMirrorRelativePath(fsPath)) {
      return;
    }

    await this.refresh(false);
  }
}

class RemoteDeviceFileSystemProvider implements vscode.FileSystemProvider {
  private readonly onDidChangeFileEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.onDidChangeFileEmitter.event;

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const file = await this.readFile(uri);
    return {
      type: vscode.FileType.File,
      ctime: 0,
      mtime: Date.now(),
      size: file.length
    };
  }

  readDirectory(): [string, vscode.FileType][] {
    return [];
  }

  createDirectory(): void {
    throw vscode.FileSystemError.NoPermissions('Creating directories on remote URI is not supported.');
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const board = getConnectedBoard();
    if (!board) {
      throw vscode.FileSystemError.Unavailable('Board not connected.');
    }

    const relativePath = this.toRelativeRemotePath(uri);
    const content = await readDeviceFile(board, relativePath);
    return new Uint8Array(content);
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const board = getConnectedBoard();
    if (!board) {
      throw vscode.FileSystemError.Unavailable('Board not connected.');
    }

    const relativePath = this.toRelativeRemotePath(uri);
    await writeDeviceFile(board, relativePath, Buffer.from(content));
    logChannelOutput(`Saved to device: ${relativePath}`, true);
    this.onDidChangeFileEmitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  delete(): void {
    throw vscode.FileSystemError.NoPermissions('Deleting on remote URI is not supported.');
  }

  rename(): void {
    throw vscode.FileSystemError.NoPermissions('Renaming on remote URI is not supported.');
  }

  private toRelativeRemotePath(uri: vscode.Uri): string {
    const relativePath = toRelativePath(uri.path.replace(/^\/+/, ''));
    if (!relativePath) {
      throw vscode.FileSystemError.FileNotFound('Remote file path is empty.');
    }

    return relativePath;
  }
}

class SideTreeProvider implements vscode.TreeDataProvider<MirrorNode>, vscode.Disposable {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<MirrorNode | undefined>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private readonly modelDisposable: vscode.Disposable;

  constructor(private readonly side: NodeSide, private readonly model: DeviceMirrorModel) {
    this.modelDisposable = model.onDidChangeData(() => this.onDidChangeTreeDataEmitter.fire(undefined));
  }

  dispose(): void {
    this.modelDisposable.dispose();
    this.onDidChangeTreeDataEmitter.dispose();
  }

  getTreeItem(element: MirrorNode): vscode.TreeItem {
    const data = element.data;
    if (data.isIndicator) {
      element.contextValue = 'pyboarddev.deviceIndicator';
      element.iconPath = new vscode.ThemeIcon('warning');
      element.description = 'connect to view files';
      element.command = {
        command: 'mekatrol.pyboarddev.toggleboardconnection',
        title: 'Connect to board'
      };
      return element;
    }

    element.contextValue = data.side === 'device' ? 'pyboarddev.deviceNode' : 'pyboarddev.localNode';
    element.iconPath = data.isDirectory ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;

    if (!data.isDirectory) {
      const sync = this.model.getSyncState(data.relativePath);
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
        command: commandOpenRemoteFileId,
        title: 'Open remote device file',
        arguments: [element]
      };
    }

    return element;
  }

  getChildren(element?: MirrorNode): MirrorNode[] {
    const parentRelativePath = element ? element.data.relativePath : '';
    if (element && !element.data.isDirectory) {
      return [];
    }

    if (!element && this.side === 'device' && !this.model.isBoardConnected()) {
      return [
        new MirrorNode(
          {
            side: 'device',
            relativePath: '',
            isDirectory: false,
            isIndicator: true
          },
          'Device not connected',
          vscode.TreeItemCollapsibleState.None
        )
      ];
    }

    return this.model.getNodeChildren(this.side, parentRelativePath);
  }
}

export const initDeviceMirrorExplorer = async (context: vscode.ExtensionContext): Promise<void> => {
  const model = new DeviceMirrorModel(context);
  const remoteFsProvider = new RemoteDeviceFileSystemProvider();

  const localProvider = new SideTreeProvider('local', model);
  const deviceProvider = new SideTreeProvider('device', model);

  context.subscriptions.push(localProvider);
  context.subscriptions.push(deviceProvider);
  context.subscriptions.push(vscode.window.registerTreeDataProvider(localViewId, localProvider));
  context.subscriptions.push(vscode.window.registerTreeDataProvider(deviceViewId, deviceProvider));
  context.subscriptions.push(vscode.workspace.registerFileSystemProvider(remoteDocumentScheme, remoteFsProvider, { isCaseSensitive: true }));

  context.subscriptions.push(onBoardConnectionStateChanged(() => model.refresh()));
  context.subscriptions.push(onPythonTypeChanged(() => model.refresh(false)));
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument((document) => model.handleDocumentSaved(document)));
  context.subscriptions.push(vscode.workspace.onDidDeleteFiles((event) => event.files.forEach((uri) => model.handlePossibleMirrorFileChange(uri.fsPath))));
  context.subscriptions.push(vscode.workspace.onDidCreateFiles((event) => event.files.forEach((uri) => model.handlePossibleMirrorFileChange(uri.fsPath))));

  context.subscriptions.push(vscode.commands.registerCommand(commandRefreshId, async () => model.refresh(true)));
  context.subscriptions.push(vscode.commands.registerCommand(commandSyncFromDeviceId, async () => model.syncFromDevice()));
  context.subscriptions.push(vscode.commands.registerCommand(commandSyncToDeviceId, async () => model.syncToDevice()));
  context.subscriptions.push(vscode.commands.registerCommand(commandOpenLocalItemId, async (node: MirrorNode) => model.openLocalNode(node)));
  context.subscriptions.push(vscode.commands.registerCommand(commandPullAndOpenDeviceItemId, async (node: MirrorNode) => model.pullDeviceNodeAndOpen(node)));
  context.subscriptions.push(vscode.commands.registerCommand(commandOpenRemoteFileId, async (node?: MirrorNode) => model.openRemoteFile(node)));

  await model.refresh();
};
