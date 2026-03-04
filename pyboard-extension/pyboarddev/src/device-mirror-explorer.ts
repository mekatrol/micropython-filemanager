import { Buffer } from 'buffer';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getConnectedBoard, onBoardConnectionStateChanged } from './commands/connect-board-command';
import { logChannelOutput } from './output-channel';
import { onPythonTypeChanged } from './status-bar';
import { loadConfiguration } from './utils/configuration';
import {
  createDeviceDirectory,
  deleteDevicePath,
  FileEntry,
  SyncState,
  buildSyncStateMap,
  listDeviceEntries,
  normaliseObfuscationSet,
  readDeviceFile,
  renameDevicePath,
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
const commandCompareRemoteWithLocalId = 'mekatrol.pyboarddev.compareremotewithlocal';
const commandCreateRemoteFileId = 'mekatrol.pyboarddev.createremotefile';
const commandCreateRemoteFolderId = 'mekatrol.pyboarddev.createremotefolder';
const commandRenameRemotePathId = 'mekatrol.pyboarddev.renameremotepath';
const commandDeleteRemotePathId = 'mekatrol.pyboarddev.deleteremotepath';
const remoteDocumentScheme = 'pyboarddev-remote';
const selectedPythonTypeStateKey = 'selectedPythonType';
const selectedSerialPortStateKey = 'selectedSerialPort';
const selectedBaudRateStateKey = 'selectedBaudRate';
const defaultBaudRate = 115200;
const remoteExplorerAutoRefreshIntervalMs = 5000;

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
  private selectedRemoteNode: MirrorNode | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly notifyRemoteFilesChanged?: (relativePaths: string[]) => Promise<void>,
    private readonly notifyRemotePathDeleted?: (relativePath: string, includeDescendants: boolean) => Promise<void>
  ) {}

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
    const updatedDeviceFiles: string[] = [];
    const desiredDevicePaths = new Set(deviceEntries.map((entry) => toRelativePath(entry.relativePath)));

    // Remove local mirror entries that no longer exist on the device.
    const existingLocalEntries = await scanLocalMirrorEntries(this.mirrorRootPath);
    const staleLocalEntries = existingLocalEntries
      .filter((entry) => entry.relativePath.length > 0 && !desiredDevicePaths.has(entry.relativePath))
      .sort((a, b) => b.relativePath.length - a.relativePath.length);
    for (const staleEntry of staleLocalEntries) {
      const stalePath = path.join(this.mirrorRootPath, staleEntry.relativePath);
      await fs.rm(stalePath, { recursive: true, force: true });
    }

    for (const entry of deviceEntries) {
      if (entry.relativePath.length === 0) {
        continue;
      }

      const localPath = path.join(this.mirrorRootPath, entry.relativePath);
      if (entry.isDirectory) {
        try {
          const stat = await fs.stat(localPath);
          if (!stat.isDirectory()) {
            await fs.rm(localPath, { recursive: true, force: true });
          }
        } catch {
          // Path does not exist; create it below.
        }
        await fs.mkdir(localPath, { recursive: true });
        continue;
      }

      try {
        const stat = await fs.stat(localPath);
        if (stat.isDirectory()) {
          await fs.rm(localPath, { recursive: true, force: true });
        }
      } catch {
        // Path does not exist; create parent below.
      }
      await fs.mkdir(path.dirname(localPath), { recursive: true });
      if (this.obfuscationSet.has(entry.relativePath)) {
        await fs.writeFile(localPath, obfuscatedPlaceholder, 'utf8');
        continue;
      }

      const content = await readDeviceFile(board, entry.relativePath);
      await fs.writeFile(localPath, content);
      updatedDeviceFiles.push(entry.relativePath);
    }

    this.deviceEntries = deviceEntries;
    this.localEntries = await scanLocalMirrorEntries(this.mirrorRootPath);
    this.syncStates = buildSyncStateMap(this.localEntries, this.deviceEntries, this.obfuscationSet);
    this.onDidChangeDataEmitter.fire();
    if (this.notifyRemoteFilesChanged) {
      await this.notifyRemoteFilesChanged(updatedDeviceFiles);
    }

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
    const localDirectories = localEntries
      .filter((entry) => entry.isDirectory && entry.relativePath.length > 0)
      .sort((a, b) => a.relativePath.split('/').length - b.relativePath.split('/').length);
    for (const directory of localDirectories) {
      await createDeviceDirectory(board, directory.relativePath);
    }

    const writtenDeviceFiles: string[] = [];
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
      writtenDeviceFiles.push(entry.relativePath);
    }

    this.localEntries = localEntries;
    this.deviceEntries = await listDeviceEntries(board);
    this.syncStates = buildSyncStateMap(this.localEntries, this.deviceEntries, this.obfuscationSet);
    this.onDidChangeDataEmitter.fire();
    if (this.notifyRemoteFilesChanged) {
      await this.notifyRemoteFilesChanged(writtenDeviceFiles);
    }

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

  async compareRemoteWithLocal(node?: MirrorNode): Promise<void> {
    if (node) {
      await this.openRemoteDiff(node);
      return;
    }

    const board = getConnectedBoard();
    if (!board) {
      vscode.window.showWarningMessage('Connect to a board before comparing a remote file.');
      return;
    }

    const files = this.deviceEntries
      .filter((entry) => !entry.isDirectory && entry.relativePath.length > 0)
      .sort((a, b) => a.relativePath.localeCompare(b.relativePath));

    if (files.length === 0) {
      vscode.window.showInformationMessage('No remote files available to compare.');
      return;
    }

    const selected = await vscode.window.showQuickPick(
      files.map((item) => ({ label: item.relativePath })),
      {
        placeHolder: 'Select a remote file to compare',
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

    await this.openRemoteDiff(quickPickNode);
  }

  async createRemoteFile(node?: MirrorNode): Promise<void> {
    const board = getConnectedBoard();
    if (!board) {
      vscode.window.showWarningMessage('Connect to a board before creating a remote file.');
      return;
    }

    const parentPath = this.getRemoteParentPath(node);
    const fileName = await vscode.window.showInputBox({
      title: 'Create Remote File',
      prompt: parentPath ? `Create in /${parentPath}` : 'Create in /',
      placeHolder: 'filename.py',
      ignoreFocusOut: true,
      validateInput: (value) => this.validateRemoteName(value)
    });

    if (!fileName) {
      return;
    }

    const relativePath = this.joinRemotePath(parentPath, fileName);
    await writeDeviceFile(board, relativePath, Buffer.alloc(0));
    await this.refresh(true);
    if (this.notifyRemoteFilesChanged) {
      await this.notifyRemoteFilesChanged([relativePath]);
    }

    const msg = `Created remote file: /${relativePath}`;
    vscode.window.showInformationMessage(msg);
    logChannelOutput(msg, true);
  }

  async createRemoteFolder(node?: MirrorNode): Promise<void> {
    const board = getConnectedBoard();
    if (!board) {
      vscode.window.showWarningMessage('Connect to a board before creating a remote folder.');
      return;
    }

    const parentPath = this.getRemoteParentPath(node);
    const folderName = await vscode.window.showInputBox({
      title: 'Create Remote Folder',
      prompt: parentPath ? `Create in /${parentPath}` : 'Create in /',
      placeHolder: 'folder',
      ignoreFocusOut: true,
      validateInput: (value) => this.validateRemoteName(value)
    });

    if (!folderName) {
      return;
    }

    const relativePath = this.joinRemotePath(parentPath, folderName);
    await createDeviceDirectory(board, relativePath);
    await this.refresh(true);

    const msg = `Created remote folder: /${relativePath}`;
    vscode.window.showInformationMessage(msg);
    logChannelOutput(msg, true);
  }

  async renameRemotePath(node?: MirrorNode): Promise<void> {
    node = node ?? this.selectedRemoteNode;
    if (!node || node.data.side !== 'device') {
      vscode.window.showWarningMessage('Select a remote file or folder to rename.');
      return;
    }

    const board = getConnectedBoard();
    if (!board) {
      vscode.window.showWarningMessage('Connect to a board before renaming remote items.');
      return;
    }

    const currentPath = toRelativePath(node.data.relativePath);
    const currentName = path.posix.basename(currentPath);
    const parentPath = path.posix.dirname(currentPath) === '.' ? '' : path.posix.dirname(currentPath);
    const nextName = await vscode.window.showInputBox({
      title: `Rename Remote ${node.data.isDirectory ? 'Folder' : 'File'}`,
      prompt: `Current: /${currentPath}`,
      value: currentName,
      ignoreFocusOut: true,
      validateInput: (value) => this.validateRemoteName(value)
    });

    if (!nextName || nextName === currentName) {
      return;
    }

    const nextPath = this.joinRemotePath(parentPath, nextName);
    await renameDevicePath(board, currentPath, nextPath);

    if (this.notifyRemotePathDeleted) {
      await this.notifyRemotePathDeleted(currentPath, node.data.isDirectory);
    }
    await this.refresh(true);
    if (!node.data.isDirectory && this.notifyRemoteFilesChanged) {
      await this.notifyRemoteFilesChanged([nextPath]);
    }

    const msg = `Renamed remote path: /${currentPath} -> /${nextPath}`;
    vscode.window.showInformationMessage(msg);
    logChannelOutput(msg, true);
  }

  async deleteRemotePath(node?: MirrorNode): Promise<void> {
    node = node ?? this.selectedRemoteNode;
    if (!node || node.data.side !== 'device') {
      vscode.window.showWarningMessage('Select a remote file or folder to delete.');
      return;
    }

    const board = getConnectedBoard();
    if (!board) {
      vscode.window.showWarningMessage('Connect to a board before deleting remote items.');
      return;
    }

    const targetPath = toRelativePath(node.data.relativePath);
    const action = await vscode.window.showWarningMessage(
      `Delete remote ${node.data.isDirectory ? 'folder' : 'file'} "/${targetPath}"?`,
      { modal: true },
      'Delete'
    );
    if (action !== 'Delete') {
      return;
    }

    await deleteDevicePath(board, targetPath);
    if (this.notifyRemotePathDeleted) {
      await this.notifyRemotePathDeleted(targetPath, node.data.isDirectory);
    }
    await this.refresh(true);

    const msg = `Deleted remote path: /${targetPath}`;
    vscode.window.showInformationMessage(msg);
    logChannelOutput(msg, true);
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

  setSelectedRemoteNode(node: MirrorNode | undefined): void {
    this.selectedRemoteNode = node?.data.side === 'device' ? node : undefined;
  }

  private getRemoteParentPath(node?: MirrorNode): string {
    if (!node || node.data.side !== 'device') {
      return '';
    }

    if (node.data.isDirectory) {
      return toRelativePath(node.data.relativePath);
    }

    const parent = path.posix.dirname(node.data.relativePath);
    return parent === '.' ? '' : toRelativePath(parent);
  }

  private joinRemotePath(parentPath: string, name: string): string {
    const trimmedName = name.trim();
    if (!parentPath) {
      return toRelativePath(trimmedName);
    }
    return toRelativePath(path.posix.join(parentPath, trimmedName));
  }

  private validateRemoteName(value: string): string | undefined {
    const trimmed = value.trim();
    if (!trimmed) {
      return 'Name is required.';
    }
    if (trimmed.includes('/')) {
      return 'Use a single name, not a path.';
    }
    if (trimmed === '.' || trimmed === '..') {
      return 'Invalid name.';
    }
    return undefined;
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

  private async openRemoteDiff(node: MirrorNode): Promise<void> {
    if (!getConnectedBoard()) {
      vscode.window.showWarningMessage('Connect to a board before comparing a device file.');
      return;
    }

    if (!this.mirrorRootPath) {
      await this.refresh(false);
    }

    if (!this.mirrorRootPath || node.data.isDirectory) {
      return;
    }

    const relativePath = toRelativePath(node.data.relativePath);
    const localPath = path.join(this.mirrorRootPath, relativePath);
    try {
      const stat = await fs.stat(localPath);
      if (!stat.isFile()) {
        throw new Error('Not a file');
      }
    } catch {
      vscode.window.showWarningMessage(`No host mirror file exists for "${relativePath}". Sync from device first.`);
      return;
    }

    const localUri = vscode.Uri.file(localPath);
    const remoteUri = vscode.Uri.parse(`${remoteDocumentScheme}:/${relativePath}`);
    const title = `${relativePath} (Host <-> Device)`;
    await vscode.commands.executeCommand('vscode.diff', localUri, remoteUri, title, { preview: false });
  }
}

class RemoteDeviceFileSystemProvider implements vscode.FileSystemProvider {
  private readonly onDidChangeFileEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.onDidChangeFileEmitter.event;
  private static readonly waitForConnectionSettingKey = 'remoteFileOpenWaitForConnectionMs';
  private static readonly defaultWaitForConnectionMs = 120000;
  private readonly statCache = new Map<string, vscode.FileStat>();
  private readonly backupRootPath: string;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.backupRootPath = path.join(this.context.globalStorageUri.fsPath, 'remote-working-copy');
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const file = await this.readFile(uri);
    const key = uri.toString();
    const previous = this.statCache.get(key);
    const next: vscode.FileStat = {
      type: vscode.FileType.File,
      ctime: previous?.ctime ?? 0,
      mtime: previous?.mtime ?? 0,
      size: file.length
    };
    this.statCache.set(key, next);
    return next;
  }

  readDirectory(): [string, vscode.FileType][] {
    return [];
  }

  createDirectory(): void {
    throw vscode.FileSystemError.NoPermissions('Creating directories on remote URI is not supported.');
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const fallbackFilePath = this.describeRemotePath(uri);
    let board: NonNullable<ReturnType<typeof getConnectedBoard>>;
    try {
      board = await this.getConnectedBoardOrWait();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const friendlyMessage = `device no longer available for the file. File: ${fallbackFilePath}. ${this.getDeviceDetails()}`;
      vscode.window.showWarningMessage(friendlyMessage);
      logChannelOutput(`Remote file not opened. ${friendlyMessage}`, true);
      await this.closeRemoteTabsForUriWithRetry(uri);
      throw vscode.FileSystemError.Unavailable(`${friendlyMessage} (${message})`);
    }

    const relativePath = this.toRelativeRemotePath(uri, board);
    try {
      const content = await readDeviceFile(board, relativePath);
      const data = new Uint8Array(content);
      const key = uri.toString();
      const previous = this.statCache.get(key);
      this.statCache.set(key, {
        type: vscode.FileType.File,
        ctime: previous?.ctime ?? 0,
        mtime: previous?.mtime ?? 0,
        size: data.length
      });
      return data;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/no such file|enoent|not found/i.test(message)) {
        const friendlyMessage = `the file no longer exists on the device. File: ${relativePath}. ${this.getDeviceDetails(board)}`;
        vscode.window.showWarningMessage(friendlyMessage);
        logChannelOutput(`Remote file not opened. ${friendlyMessage}`, true);
        await this.closeRemoteTabsForUriWithRetry(uri);
        throw vscode.FileSystemError.FileNotFound(friendlyMessage);
      }
      const readFailureMessage = `failed to open remote file. File: ${relativePath}. ${this.getDeviceDetails(board)}. ${message}`;
      logChannelOutput(`Remote file not opened. ${readFailureMessage}`, true);
      await this.closeRemoteTabsForUriWithRetry(uri);
      throw vscode.FileSystemError.Unavailable(`Failed to read remote file: ${relativePath}. ${message}`);
    }
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const board = await this.getConnectedBoardOrWait();
    const relativePath = this.toRelativeRemotePath(uri, board);
    try {
      await writeDeviceFile(board, relativePath, Buffer.from(content));
      await this.removeWorkingCopy(uri);
      const key = uri.toString();
      const previous = this.statCache.get(key);
      this.statCache.set(key, {
        type: vscode.FileType.File,
        ctime: previous?.ctime ?? Date.now(),
        mtime: Date.now(),
        size: content.length
      });
      logChannelOutput(`Saved to device: ${relativePath}`, true);
      this.onDidChangeFileEmitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw vscode.FileSystemError.Unavailable(`Failed to write remote file: ${relativePath}. ${message}`);
    }
  }

  delete(): void {
    throw vscode.FileSystemError.NoPermissions('Deleting on remote URI is not supported.');
  }

  rename(): void {
    throw vscode.FileSystemError.NoPermissions('Renaming on remote URI is not supported.');
  }

  async notifyRemoteFilesChanged(relativePaths: string[]): Promise<void> {
    if (relativePaths.length === 0) {
      return;
    }

    const uniqueRelativePaths = [...new Set(relativePaths.map((item) => toRelativePath(item)).filter((item) => item.length > 0))];
    if (uniqueRelativePaths.length === 0) {
      return;
    }

    const events: vscode.FileChangeEvent[] = [];
    for (const relativePath of uniqueRelativePaths) {
      const uri = this.toRemoteUri(relativePath);
      this.statCache.delete(uri.toString());
      events.push({ type: vscode.FileChangeType.Changed, uri });
    }

    this.onDidChangeFileEmitter.fire(events);
  }

  async notifyRemotePathDeleted(relativePath: string, includeDescendants: boolean): Promise<void> {
    const normalisedTarget = toRelativePath(relativePath);
    if (!normalisedTarget) {
      return;
    }

    const uriMap = new Map<string, vscode.Uri>();
    const registerUri = (uri: vscode.Uri): void => {
      if (uri.scheme !== remoteDocumentScheme) {
        return;
      }

      const raw = toRelativePath(uri.path.replace(/^\/+/, ''));
      if (!raw) {
        return;
      }

      if (!this.matchesDeletedPath(raw, normalisedTarget, includeDescendants)) {
        return;
      }

      uriMap.set(uri.toString(), uri);
    };

    for (const document of vscode.workspace.textDocuments) {
      registerUri(document.uri);
    }

    for (const key of this.statCache.keys()) {
      registerUri(vscode.Uri.parse(key));
    }

    if (uriMap.size === 0) {
      return;
    }

    const events: vscode.FileChangeEvent[] = [];
    for (const uri of uriMap.values()) {
      this.statCache.delete(uri.toString());
      await this.removeWorkingCopy(uri);
      await this.closeRemoteTabsForUriWithRetry(uri);
      events.push({ type: vscode.FileChangeType.Deleted, uri });
    }

    this.onDidChangeFileEmitter.fire(events);
  }

  private toRelativeRemotePath(uri: vscode.Uri, board: NonNullable<ReturnType<typeof getConnectedBoard>>): string {
    const rawPath = toRelativePath(uri.path.replace(/^\/+/, ''));
    const segments = rawPath
      .split('/')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);

    if (segments.length === 0) {
      throw vscode.FileSystemError.FileNotFound('Remote file path is empty.');
    }

    // Backward compatibility with older remote URI formats:
    // - /MicroPython:/<device>/<path>
    // - /<device>/<path>
    if (segments[0].endsWith(':') && segments.length > 1) {
      segments.shift();
    }

    const deviceName = (path.basename(board.device) || board.device).replace(/[^\w.-]/g, '_');
    if (segments[0] === deviceName && segments.length > 1) {
      segments.shift();
    }

    const relativePath = toRelativePath(segments.join('/'));
    if (!relativePath) {
      throw vscode.FileSystemError.FileNotFound('Remote file path is empty.');
    }

    return relativePath;
  }

  private toRemoteUri(relativePath: string): vscode.Uri {
    const normalised = toRelativePath(relativePath).replace(/^\/+/, '');
    return vscode.Uri.parse(`${remoteDocumentScheme}:/${normalised}`);
  }

  private matchesDeletedPath(candidatePath: string, deletedPath: string, includeDescendants: boolean): boolean {
    if (candidatePath === deletedPath) {
      return true;
    }

    if (!includeDescendants) {
      return false;
    }

    return candidatePath.startsWith(`${deletedPath}/`);
  }

  async updateWorkingCopyFromDocument(document: vscode.TextDocument): Promise<void> {
    if (document.uri.scheme !== remoteDocumentScheme) {
      return;
    }

    if (!document.isDirty) {
      await this.removeWorkingCopy(document.uri);
      return;
    }

    const content = Buffer.from(document.getText(), 'utf8');
    await this.writeWorkingCopy(document.uri, content);

    const now = Date.now();
    this.statCache.set(document.uri.toString(), {
      type: vscode.FileType.File,
      ctime: now,
      mtime: now,
      size: content.length
    });
  }

  async clearWorkingCopy(uri: vscode.Uri): Promise<void> {
    if (uri.scheme !== remoteDocumentScheme) {
      return;
    }

    await this.removeWorkingCopy(uri);
  }

  async restoreWorkingCopyToDocument(document: vscode.TextDocument): Promise<void> {
    if (document.uri.scheme !== remoteDocumentScheme || document.isClosed) {
      return;
    }

    const workingCopy = await this.readWorkingCopy(document.uri);
    if (!workingCopy) {
      return;
    }

    const restoredText = Buffer.from(workingCopy).toString('utf8');
    if (document.getText() === restoredText) {
      return;
    }

    const fullRange = new vscode.Range(
      document.positionAt(0),
      document.positionAt(document.getText().length)
    );
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, fullRange, restoredText);
    await vscode.workspace.applyEdit(edit);
  }

  private async getConnectedBoardOrWait(): Promise<NonNullable<ReturnType<typeof getConnectedBoard>>> {
    const connected = getConnectedBoard();
    if (connected) {
      return connected;
    }

    const configuredWait = vscode.workspace
      .getConfiguration('mekatrol.pyboarddev')
      .get<number>(
        RemoteDeviceFileSystemProvider.waitForConnectionSettingKey,
        RemoteDeviceFileSystemProvider.defaultWaitForConnectionMs
      );
    const timeoutMs = Number.isFinite(configuredWait)
      ? Math.max(0, configuredWait)
      : RemoteDeviceFileSystemProvider.defaultWaitForConnectionMs;

    return await new Promise((resolve, reject) => {
      let timeout: NodeJS.Timeout | undefined;
      const disposable = onBoardConnectionStateChanged(() => {
        const board = getConnectedBoard();
        if (!board) {
          return;
        }

        if (timeout) {
          clearTimeout(timeout);
        }
        disposable.dispose();
        resolve(board);
      });

      if (timeoutMs > 0) {
        timeout = setTimeout(() => {
          disposable.dispose();
          reject(vscode.FileSystemError.Unavailable(`Board not connected within ${timeoutMs}ms.`));
        }, timeoutMs);
      }
    });
  }

  private workingCopyPath(uri: vscode.Uri): string {
    const key = Buffer.from(uri.toString(), 'utf8').toString('base64url');
    return path.join(this.backupRootPath, `${key}.txt`);
  }

  private async readWorkingCopy(uri: vscode.Uri): Promise<Uint8Array | undefined> {
    try {
      const content = await fs.readFile(this.workingCopyPath(uri));
      return new Uint8Array(content);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  }

  private async writeWorkingCopy(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    await fs.mkdir(this.backupRootPath, { recursive: true });
    await fs.writeFile(this.workingCopyPath(uri), Buffer.from(content));
  }

  private async removeWorkingCopy(uri: vscode.Uri): Promise<void> {
    try {
      await fs.unlink(this.workingCopyPath(uri));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  private getDeviceDetails(board?: NonNullable<ReturnType<typeof getConnectedBoard>>): string {
    const selectedDevice = this.context.workspaceState.get<string>(selectedSerialPortStateKey);
    const selectedBaudRate = this.context.workspaceState.get<number>(selectedBaudRateStateKey) ?? defaultBaudRate;
    const activeBoard = board ?? getConnectedBoard();
    const device = activeBoard?.device ?? selectedDevice ?? 'unknown device';
    const baudRate = activeBoard?.baudrate ?? selectedBaudRate;
    const connectionState = activeBoard ? 'connected' : 'disconnected';
    return `Device: ${device} @ ${baudRate} (${connectionState})`;
  }

  private describeRemotePath(uri: vscode.Uri, board?: NonNullable<ReturnType<typeof getConnectedBoard>>): string {
    if (board) {
      return this.toRelativeRemotePath(uri, board);
    }

    const rawPath = toRelativePath(uri.path.replace(/^\/+/, ''));
    return rawPath || '<unknown>';
  }

  private async closeRemoteTabsForUriWithRetry(uri: vscode.Uri): Promise<void> {
    await this.closeRemoteTabsForUri(uri);
    await this.delay(50);
    await this.closeRemoteTabsForUri(uri);
    await this.delay(250);
    await this.closeRemoteTabsForUri(uri);
  }

  private async closeRemoteTabsForUri(uri: vscode.Uri): Promise<void> {
    const tabsToClose: vscode.Tab[] = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputText) {
          if (tab.input.uri.toString() !== uri.toString()) {
            continue;
          }
          tabsToClose.push(tab);
          continue;
        }

        if (tab.input instanceof vscode.TabInputTextDiff) {
          const originalMatches = tab.input.original.toString() === uri.toString();
          const modifiedMatches = tab.input.modified.toString() === uri.toString();
          if (!originalMatches && !modifiedMatches) {
            continue;
          }
          tabsToClose.push(tab);
          continue;
        }
      }
    }

    if (tabsToClose.length > 0) {
      await vscode.window.tabGroups.close(tabsToClose, true);
      return;
    }

    const visibleEditors = vscode.window.visibleTextEditors.filter(
      (editor) => editor.document.uri.toString() === uri.toString()
    );
    for (const editor of visibleEditors) {
      await vscode.window.showTextDocument(editor.document, {
        viewColumn: editor.viewColumn,
        preserveFocus: false,
        preview: false
      });
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    }
  }

  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
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
    element.tooltip = undefined;

    if (data.isIndicator) {
      element.contextValue = 'pyboarddev.deviceIndicator';
      element.iconPath = new vscode.ThemeIcon('warning');
      element.command = undefined;
      return element;
    }

    if (data.side === 'device') {
      element.contextValue = data.isDirectory ? 'pyboarddev.deviceFolder' : 'pyboarddev.deviceFile';
    } else {
      element.contextValue = data.isDirectory ? 'pyboarddev.localFolder' : 'pyboarddev.localFile';
    }
    element.iconPath = data.isDirectory ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;

    element.description = undefined;

    element.command = undefined;

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
  const remoteFsProvider = new RemoteDeviceFileSystemProvider(context);
  const model = new DeviceMirrorModel(context, async (relativePaths: string[]) => {
    await remoteFsProvider.notifyRemoteFilesChanged(relativePaths);
  }, async (relativePath: string, includeDescendants: boolean) => {
    await remoteFsProvider.notifyRemotePathDeleted(relativePath, includeDescendants);
  });

  const localProvider = new SideTreeProvider('local', model);
  const deviceProvider = new SideTreeProvider('device', model);

  context.subscriptions.push(localProvider);
  context.subscriptions.push(deviceProvider);
  const localTreeView = vscode.window.createTreeView(localViewId, { treeDataProvider: localProvider });
  const deviceTreeView = vscode.window.createTreeView(deviceViewId, { treeDataProvider: deviceProvider });
  context.subscriptions.push(localTreeView);
  context.subscriptions.push(deviceTreeView);
  context.subscriptions.push(vscode.workspace.registerFileSystemProvider(remoteDocumentScheme, remoteFsProvider, { isCaseSensitive: true }));

  context.subscriptions.push(localTreeView.onDidChangeSelection(async (event) => {
    const node = event.selection[0];
    if (!node || node.data.side !== 'local' || node.data.isDirectory) {
      return;
    }

    await model.openLocalNode(node);
  }));

  context.subscriptions.push(deviceTreeView.onDidChangeSelection(async (event) => {
    const node = event.selection[0];
    model.setSelectedRemoteNode(node);
    if (!node || node.data.side !== 'device' || node.data.isDirectory) {
      return;
    }

    await model.openRemoteFile(node);
  }));

  context.subscriptions.push(deviceTreeView.onDidChangeVisibility((event) => {
    if (!event.visible || !model.isBoardConnected()) {
      return;
    }

    void model.refresh(true);
  }));

  const remoteExplorerAutoRefreshTimer = setInterval(() => {
    if (!deviceTreeView.visible || !model.isBoardConnected()) {
      return;
    }

    void model.refresh(true);
  }, remoteExplorerAutoRefreshIntervalMs);
  context.subscriptions.push(new vscode.Disposable(() => clearInterval(remoteExplorerAutoRefreshTimer)));

  context.subscriptions.push(onBoardConnectionStateChanged(() => model.refresh()));
  context.subscriptions.push(onPythonTypeChanged(() => model.refresh(false)));
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument((document) => model.handleDocumentSaved(document)));
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((event) => void remoteFsProvider.updateWorkingCopyFromDocument(event.document)));
  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument((document) => void remoteFsProvider.restoreWorkingCopyToDocument(document)));
  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((document) => {
      if (document.uri.scheme === remoteDocumentScheme && !document.isDirty) {
        void remoteFsProvider.clearWorkingCopy(document.uri);
      }
    })
  );
  context.subscriptions.push(vscode.workspace.onDidDeleteFiles((event) => event.files.forEach((uri) => model.handlePossibleMirrorFileChange(uri.fsPath))));
  context.subscriptions.push(vscode.workspace.onDidCreateFiles((event) => event.files.forEach((uri) => model.handlePossibleMirrorFileChange(uri.fsPath))));

  context.subscriptions.push(vscode.commands.registerCommand(commandRefreshId, async () => model.refresh(true)));
  context.subscriptions.push(vscode.commands.registerCommand(commandSyncFromDeviceId, async () => model.syncFromDevice()));
  context.subscriptions.push(vscode.commands.registerCommand(commandSyncToDeviceId, async () => model.syncToDevice()));
  context.subscriptions.push(vscode.commands.registerCommand(commandOpenLocalItemId, async (node: MirrorNode) => model.openLocalNode(node)));
  context.subscriptions.push(vscode.commands.registerCommand(commandPullAndOpenDeviceItemId, async (node: MirrorNode) => model.pullDeviceNodeAndOpen(node)));
  context.subscriptions.push(vscode.commands.registerCommand(commandOpenRemoteFileId, async (node?: MirrorNode) => model.openRemoteFile(node)));
  context.subscriptions.push(vscode.commands.registerCommand(commandCompareRemoteWithLocalId, async (node?: MirrorNode) => model.compareRemoteWithLocal(node)));
  context.subscriptions.push(vscode.commands.registerCommand(commandCreateRemoteFileId, async (node?: MirrorNode) => model.createRemoteFile(node)));
  context.subscriptions.push(vscode.commands.registerCommand(commandCreateRemoteFolderId, async (node?: MirrorNode) => model.createRemoteFolder(node)));
  context.subscriptions.push(vscode.commands.registerCommand(commandRenameRemotePathId, async (node?: MirrorNode) => model.renameRemotePath(node)));
  context.subscriptions.push(vscode.commands.registerCommand(commandDeleteRemotePathId, async (node?: MirrorNode) => model.deleteRemotePath(node)));

  await model.refresh();
};
