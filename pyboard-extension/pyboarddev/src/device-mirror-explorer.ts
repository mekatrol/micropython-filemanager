import { Buffer } from 'buffer';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { closeAllConnectedBoards, getConnectedBoard, getConnectedBoards, onBoardConnectionStateChanged, onBoardConnectionsChanged } from './commands/connect-board-command';
import { logChannelOutput } from './output-channel';
import {
  getDeviceAliases,
  getDeviceHostFolderMappings,
  getDeviceSyncExcludedPaths,
  loadConfiguration,
  updateDeviceAlias,
  updateDeviceSyncExcludedPaths,
  updateDeviceHostFolderMapping,
  updateDeviceSyncExclusion
} from './utils/configuration';
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
  scanLocalMirrorEntries,
  toRelativePath,
  writeDeviceFile
} from './utils/device-filesystem';

const mirrorViewId = 'mekatrol.pyboarddev.mirrorExplorer';
const commandRefreshId = 'mekatrol.pyboarddev.refreshmirrorview';
const commandSyncFromDeviceId = 'mekatrol.pyboarddev.syncfromdevice';
const commandSyncToDeviceId = 'mekatrol.pyboarddev.synctodevice';
const commandSyncNodeFromDeviceId = 'mekatrol.pyboarddev.syncnodefromdevice';
const commandSyncNodeToDeviceId = 'mekatrol.pyboarddev.syncnodetodevice';
const commandOpenLocalItemId = 'mekatrol.pyboarddev.openlocalmirroritem';
const commandPullAndOpenDeviceItemId = 'mekatrol.pyboarddev.pullandopendeviceitem';
const commandOpenRemoteFileId = 'mekatrol.pyboarddev.openremotefile';
const commandCompareRemoteWithLocalId = 'mekatrol.pyboarddev.compareremotewithlocal';
const commandCreateMirrorFileId = 'mekatrol.pyboarddev.createmirrorfile';
const commandCreateMirrorFolderId = 'mekatrol.pyboarddev.createmirrorfolder';
const commandRenameMirrorPathId = 'mekatrol.pyboarddev.renamemirrorpath';
const commandDeleteMirrorPathId = 'mekatrol.pyboarddev.deletemirrorpath';
const commandLinkDeviceHostFolderId = 'mekatrol.pyboarddev.linkdevicehostfolder';
const commandUnlinkDeviceHostFolderId = 'mekatrol.pyboarddev.unlinkdevicehostfolder';
const commandSetDeviceAliasId = 'mekatrol.pyboarddev.setdevicealias';
const commandExcludeDeviceFileFromSyncId = 'mekatrol.pyboarddev.excludedevicefilefromsync';
const commandRemoveDeviceFileFromSyncExclusionId = 'mekatrol.pyboarddev.removedevicefilefromsyncexclusion';
const commandCloseDeviceConnectionId = 'mekatrol.pyboarddev.closedeviceconnection';
const commandCloseAllDeviceConnectionsId = 'mekatrol.pyboarddev.closealldeviceconnections';
const commandConnectBoardWithPickerId = 'mekatrol.pyboarddev.connectboardwithpicker';
const remoteDocumentScheme = 'pyboarddev-remote';
const defaultBaudRate = 115200;
const remoteExplorerAutoRefreshIntervalMs = 5000;
const hostMirrorRootFolder = '.pyboard-mirror';
const hasHostMirrorChildFoldersContextKey = 'mekatrol.pyboarddev.hasHostMirrorChildFolders';
const hasLinkedHostMappingsContextKey = 'mekatrol.pyboarddev.hasLinkedHostMappings';

const obfuscatedPlaceholder = '# pyboarddev: obfuscated on pull\n';
const obfuscatedPlaceholderSha1 = createHash('sha1').update(Buffer.from(obfuscatedPlaceholder, 'utf8')).digest('hex');

type NodeSide = 'device' | 'local';

interface NodeData {
  side: NodeSide;
  relativePath: string;
  isDirectory: boolean;
  deviceId?: string;
  isDeviceIdNode?: boolean;
  isRoot?: boolean;
  isIndicator?: boolean;
}

type SyncAction = 'create' | 'modify' | 'delete';

interface SyncOperation {
  id: string;
  action: SyncAction;
  relativePath: string;
  isDirectory: boolean;
  excluded: boolean;
}

type SyncOperationRunStatus = 'pending' | 'in_progress' | 'success' | 'skipped' | 'error';

interface SyncOperationsDialog {
  selectedIds: Set<string>;
  setStatus: (operationId: string, status: SyncOperationRunStatus, errorText?: string) => void;
  finish: (summary: string) => Promise<void>;
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
  private deviceHostFolderMappings: Record<string, string> = {};
  private deviceAliases: Record<string, string> = {};
  private deviceSyncExcludedPaths: Record<string, Set<string>> = {};
  private knownDeviceIds: Set<string> = new Set();
  private activeDeviceId: string | undefined;
  private mirrorRootByDeviceId = new Map<string, string>();
  private localEntriesByDeviceId = new Map<string, FileEntry[]>();
  private deviceEntriesByDeviceId = new Map<string, FileEntry[]>();
  private syncStatesByDeviceId = new Map<string, Map<string, SyncState>>();
  private linkableHostFolders: string[] = [];
  private unlinkedHostEntries: FileEntry[] = [{ relativePath: '', isDirectory: true }];

  private localEntries: FileEntry[] = [{ relativePath: '', isDirectory: true }];
  private deviceEntries: FileEntry[] = [{ relativePath: '', isDirectory: true }];
  private syncStates: Map<string, SyncState> = new Map();
  private selectedNode: MirrorNode | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly notifyRemoteFilesChanged?: (relativePaths: string[]) => Promise<void>,
    private readonly notifyRemotePathDeleted?: (relativePath: string, includeDescendants: boolean) => Promise<void>
  ) {}

  async refresh(fetchDevice: boolean = true): Promise<void> {
    this.workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!this.workspaceFolder) {
      this.localEntries = [{ relativePath: '', isDirectory: true }];
      this.deviceEntries = [{ relativePath: '', isDirectory: true }];
      this.syncStates = new Map();
      this.linkableHostFolders = [];
      this.deviceSyncExcludedPaths = {};
      await vscode.commands.executeCommand('setContext', hasHostMirrorChildFoldersContextKey, false);
      await vscode.commands.executeCommand('setContext', hasLinkedHostMappingsContextKey, false);
      this.onDidChangeDataEmitter.fire();
      return;
    }

    const config = await loadConfiguration();
    this.obfuscationSet = normaliseObfuscationSet(config.obfuscateOnPull ?? []);
    this.deviceHostFolderMappings = getDeviceHostFolderMappings(config);
    this.deviceAliases = getDeviceAliases(config);
    this.deviceSyncExcludedPaths = Object.fromEntries(
      Object.entries(getDeviceSyncExcludedPaths(config)).map(([deviceId, relativePaths]) => [deviceId, new Set(relativePaths)])
    );
    this.linkableHostFolders = await this.getLinkableHostFolders();
    await vscode.commands.executeCommand('setContext', hasHostMirrorChildFoldersContextKey, this.linkableHostFolders.length > 0);
    await vscode.commands.executeCommand('setContext', hasLinkedHostMappingsContextKey, Object.keys(this.deviceHostFolderMappings).length > 0);
    this.knownDeviceIds = new Set([...Object.keys(this.deviceHostFolderMappings), ...Object.keys(this.deviceAliases)]);

    const connected = getConnectedBoards();
    connected.forEach((item) => this.knownDeviceIds.add(item.deviceId));

    for (const deviceId of this.knownDeviceIds) {
      const mirrorRootPath = this.toDeviceMirrorPath(deviceId);
      if (mirrorRootPath) {
        this.mirrorRootByDeviceId.set(deviceId, mirrorRootPath);
      } else {
        this.mirrorRootByDeviceId.delete(deviceId);
      }
      const localEntries = mirrorRootPath
        ? await scanLocalMirrorEntries(mirrorRootPath)
        : [{ relativePath: '', isDirectory: true }];
      this.localEntriesByDeviceId.set(deviceId, localEntries);

      let deviceEntries: FileEntry[] = [{ relativePath: '', isDirectory: true }];
      if (fetchDevice) {
        const board = getConnectedBoard(deviceId);
        if (board) {
          try {
            deviceEntries = await listDeviceEntries(board);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logChannelOutput(`Unable to read device filesystem (${deviceId}): ${message}`, true);
          }
        }
      } else {
        deviceEntries = this.deviceEntriesByDeviceId.get(deviceId) ?? [{ relativePath: '', isDirectory: true }];
      }

      this.deviceEntriesByDeviceId.set(deviceId, deviceEntries);
      this.syncStatesByDeviceId.set(deviceId, buildSyncStateMap(localEntries, deviceEntries, this.obfuscationSet));
    }

    if (!this.activeDeviceId || !this.knownDeviceIds.has(this.activeDeviceId)) {
      this.activeDeviceId = connected[0]?.deviceId ?? [...this.knownDeviceIds][0];
    }
    this.activateDevice(this.activeDeviceId);
    const hostRootPath = this.getHostMirrorRootPath();
    this.unlinkedHostEntries = hostRootPath
      ? await scanLocalMirrorEntries(hostRootPath)
      : [{ relativePath: '', isDirectory: true }];
    this.onDidChangeDataEmitter.fire();
  }

  private getHostMirrorRootPath(): string | undefined {
    if (!this.workspaceFolder) {
      return undefined;
    }

    return path.join(this.workspaceFolder.uri.fsPath, hostMirrorRootFolder);
  }

  private async getLinkableHostFolders(): Promise<string[]> {
    const mirrorRootPath = this.getHostMirrorRootPath();
    if (!mirrorRootPath) {
      return [];
    }
    try {
      const children = await fs.readdir(mirrorRootPath, { withFileTypes: true });
      return children
        .filter((child) => child.isDirectory())
        .map((child) => toRelativePath(path.posix.join(hostMirrorRootFolder, child.name)))
        .sort((a, b) => a.localeCompare(b));
    } catch {
      return [];
    }
  }

  private toDeviceMirrorPath(deviceId: string): string | undefined {
    if (!this.workspaceFolder) {
      return undefined;
    }

    const mapped = this.deviceHostFolderMappings[deviceId];
    if (mapped && mapped.trim().length > 0) {
      return path.join(this.workspaceFolder.uri.fsPath, mapped);
    }
    return undefined;
  }

  private activateDevice(deviceId: string | undefined): void {
    this.activeDeviceId = deviceId;
    if (!deviceId) {
      this.localEntries = [{ relativePath: '', isDirectory: true }];
      this.deviceEntries = [{ relativePath: '', isDirectory: true }];
      this.syncStates = new Map();
      this.mirrorRootPath = undefined;
      return;
    }

    this.localEntries = this.localEntriesByDeviceId.get(deviceId) ?? [{ relativePath: '', isDirectory: true }];
    this.deviceEntries = this.deviceEntriesByDeviceId.get(deviceId) ?? [{ relativePath: '', isDirectory: true }];
    this.syncStates = this.syncStatesByDeviceId.get(deviceId) ?? new Map();
    this.mirrorRootPath = this.mirrorRootByDeviceId.get(deviceId);
  }

  private getNodeDeviceId(node?: MirrorNode): string | undefined {
    if (node?.data.deviceId) {
      return node.data.deviceId;
    }

    if (this.selectedNode?.data.deviceId) {
      return this.selectedNode.data.deviceId;
    }

    return this.activeDeviceId ?? getConnectedBoards()[0]?.deviceId;
  }

  private async ensureActiveDevice(node?: MirrorNode): Promise<string | undefined> {
    const deviceId = this.getNodeDeviceId(node);
    if (!deviceId) {
      return undefined;
    }

    if (!this.knownDeviceIds.has(deviceId)) {
      this.knownDeviceIds.add(deviceId);
    }

    this.activateDevice(deviceId);
    return deviceId;
  }

  private async pickKnownDeviceId(placeHolder: string): Promise<string | undefined> {
    const candidates = this.getKnownDeviceIds();
    if (candidates.length === 0) {
      return undefined;
    }

    if (candidates.length === 1) {
      return candidates[0];
    }

    const selected = await vscode.window.showQuickPick(
      candidates.map((deviceId) => {
        const alias = this.getDeviceAlias(deviceId);
        const mapping = this.getMappedHostFolder(deviceId) ?? 'not linked';
        return {
          deviceId,
          label: alias ?? deviceId,
          description: alias ? `${deviceId} | ${mapping}` : mapping
        };
      }),
      {
        placeHolder,
        canPickMany: false,
        ignoreFocusOut: true
      }
    );
    return selected?.deviceId;
  }

  async syncFromDevice(): Promise<void> {
    await this.ensureActiveDevice();
    if (!this.workspaceFolder || !this.mirrorRootPath) {
      await this.refresh(false);
    }

    const board = getConnectedBoard(this.activeDeviceId);
    if (!board) {
      vscode.window.showWarningMessage('Connect to a board before syncing from device.');
      return;
    }

    if (!this.mirrorRootPath) {
      vscode.window.showWarningMessage('Link this device to a host folder before syncing from device.');
      return;
    }

    const deviceEntries = await listDeviceEntries(board);
    if (this.activeDeviceId) {
      await this.pruneMissingDeviceSyncExclusions(this.activeDeviceId, deviceEntries);
    }
    const localEntries = await scanLocalMirrorEntries(this.mirrorRootPath);
    const deviceEntryMap = new Map(deviceEntries.map((entry) => [toRelativePath(entry.relativePath), entry]));
    const localEntryMap = new Map(localEntries.map((entry) => [toRelativePath(entry.relativePath), entry]));
    const protectedLocalPaths = this.getProtectedSyncPaths(localEntries, this.activeDeviceId);
    const desiredDevicePaths = new Set(deviceEntries.map((entry) => toRelativePath(entry.relativePath)));
    const syncOperations: SyncOperation[] = [];

    for (const entry of deviceEntries) {
      const relativePath = toRelativePath(entry.relativePath);
      if (!relativePath) {
        continue;
      }
      const isExcluded = this.isPathExcludedFromSync(relativePath, this.activeDeviceId);

      const localEntry = localEntryMap.get(relativePath);
      if (!localEntry) {
        const operation: Omit<SyncOperation, 'id'> = {
          action: 'create',
          relativePath,
          isDirectory: entry.isDirectory,
          excluded: isExcluded
        };
        syncOperations.push({ ...operation, id: this.toSyncOperationId(operation) });
        continue;
      }

      if (localEntry.isDirectory !== entry.isDirectory) {
        const operation: Omit<SyncOperation, 'id'> = {
          action: 'modify',
          relativePath,
          isDirectory: entry.isDirectory,
          excluded: isExcluded
        };
        syncOperations.push({ ...operation, id: this.toSyncOperationId(operation) });
        continue;
      }

      if (entry.isDirectory) {
        continue;
      }

      const needsWrite = this.obfuscationSet.has(relativePath)
        ? localEntry.sha1 !== obfuscatedPlaceholderSha1
        : (!entry.sha1 || !localEntry.sha1 || entry.sha1 !== localEntry.sha1);
      if (needsWrite) {
        const operation: Omit<SyncOperation, 'id'> = {
          action: 'modify',
          relativePath,
          isDirectory: false,
          excluded: isExcluded
        };
        syncOperations.push({ ...operation, id: this.toSyncOperationId(operation) });
      }
    }

    for (const entry of localEntries) {
      const relativePath = toRelativePath(entry.relativePath);
      if (!relativePath) {
        continue;
      }
      if (desiredDevicePaths.has(relativePath)) {
        continue;
      }
      if (protectedLocalPaths.has(relativePath)) {
        if (this.isPathExcludedFromSync(relativePath, this.activeDeviceId)) {
          const operation: Omit<SyncOperation, 'id'> = {
            action: 'delete',
            relativePath,
            isDirectory: entry.isDirectory,
            excluded: true
          };
          syncOperations.push({ ...operation, id: this.toSyncOperationId(operation) });
        }
        continue;
      }
      const operation: Omit<SyncOperation, 'id'> = {
        action: 'delete',
        relativePath,
        isDirectory: entry.isDirectory,
        excluded: false
      };
      syncOperations.push({ ...operation, id: this.toSyncOperationId(operation) });
    }

    const syncDialog = await this.pickSyncOperations('Sync From Device Preview', syncOperations);
    if (!syncDialog) {
      vscode.window.showInformationMessage('Sync from device cancelled.');
      return;
    }

    const updatedDeviceFiles: string[] = [];
    const selectedOperations = syncOperations.filter((operation) => syncDialog.selectedIds.has(operation.id));
    const unselectedOperations = syncOperations.filter((operation) => !syncDialog.selectedIds.has(operation.id));
    for (const operation of unselectedOperations) {
      syncDialog.setStatus(operation.id, 'skipped');
    }
    let failedCount = 0;
    const selectedDeletes = selectedOperations
      .filter((operation) => operation.action === 'delete')
      .sort((a, b) => b.relativePath.length - a.relativePath.length);
    for (const operation of selectedDeletes) {
      syncDialog.setStatus(operation.id, 'in_progress');
      try {
        await fs.rm(path.join(this.mirrorRootPath, operation.relativePath), { recursive: true, force: true });
        syncDialog.setStatus(operation.id, 'success');
      } catch (error) {
        failedCount += 1;
        syncDialog.setStatus(operation.id, 'error', this.toErrorMessage(error));
      }
    }

    const selectedDirCreates = selectedOperations
      .filter((operation) => operation.action !== 'delete' && operation.isDirectory)
      .sort((a, b) => a.relativePath.length - b.relativePath.length);
    for (const operation of selectedDirCreates) {
      syncDialog.setStatus(operation.id, 'in_progress');
      try {
        const localPath = path.join(this.mirrorRootPath, operation.relativePath);
        try {
          const stat = await fs.stat(localPath);
          if (!stat.isDirectory()) {
            await fs.rm(localPath, { recursive: true, force: true });
          }
        } catch {
          // Path does not exist; create below.
        }
        await fs.mkdir(localPath, { recursive: true });
        syncDialog.setStatus(operation.id, 'success');
      } catch (error) {
        failedCount += 1;
        syncDialog.setStatus(operation.id, 'error', this.toErrorMessage(error));
      }
    }

    const selectedFileWrites = selectedOperations
      .filter((operation) => !operation.isDirectory && operation.action !== 'delete');
    for (const operation of selectedFileWrites) {
      syncDialog.setStatus(operation.id, 'in_progress');
      try {
        const entry = deviceEntryMap.get(operation.relativePath);
        if (!entry || entry.isDirectory) {
          syncDialog.setStatus(operation.id, 'skipped');
          continue;
        }
        const localPath = path.join(this.mirrorRootPath, operation.relativePath);
        try {
          const stat = await fs.stat(localPath);
          if (stat.isDirectory()) {
            await fs.rm(localPath, { recursive: true, force: true });
          }
        } catch {
          // Path does not exist; create parent below.
        }
        await fs.mkdir(path.dirname(localPath), { recursive: true });
        if (this.obfuscationSet.has(operation.relativePath)) {
          await fs.writeFile(localPath, obfuscatedPlaceholder, 'utf8');
          syncDialog.setStatus(operation.id, 'success');
          continue;
        }
        const content = await readDeviceFile(board, operation.relativePath);
        await fs.writeFile(localPath, content);
        updatedDeviceFiles.push(operation.relativePath);
        syncDialog.setStatus(operation.id, 'success');
      } catch (error) {
        failedCount += 1;
        syncDialog.setStatus(operation.id, 'error', this.toErrorMessage(error));
      }
    }

    this.deviceEntries = deviceEntries;
    this.localEntries = await scanLocalMirrorEntries(this.mirrorRootPath);
    this.syncStates = buildSyncStateMap(this.localEntries, this.deviceEntries, this.obfuscationSet);
    this.onDidChangeDataEmitter.fire();
    if (this.notifyRemoteFilesChanged) {
      await this.notifyRemoteFilesChanged(updatedDeviceFiles);
    }

    const msg = failedCount > 0
      ? `Sync from device finished with ${failedCount} error(s).`
      : 'Sync from device complete.';
    await syncDialog.finish(msg);
    vscode.window.showInformationMessage(msg);
    logChannelOutput(msg, true);
  }

  async syncToDevice(): Promise<void> {
    await this.ensureActiveDevice();
    if (!this.workspaceFolder || !this.mirrorRootPath) {
      await this.refresh(false);
    }

    const board = getConnectedBoard(this.activeDeviceId);
    if (!board) {
      vscode.window.showWarningMessage('Connect to a board before syncing to device.');
      return;
    }

    if (!this.mirrorRootPath) {
      vscode.window.showWarningMessage('Link this device to a host folder before syncing to device.');
      return;
    }

    const localEntries = await scanLocalMirrorEntries(this.mirrorRootPath);
    const deviceEntries = await listDeviceEntries(board);
    if (this.activeDeviceId) {
      await this.pruneMissingDeviceSyncExclusions(this.activeDeviceId, deviceEntries);
    }
    const localEntryMap = new Map(localEntries.map((entry) => [toRelativePath(entry.relativePath), entry]));
    const deviceEntryMap = new Map(deviceEntries.map((entry) => [toRelativePath(entry.relativePath), entry]));
    const protectedDevicePaths = this.getProtectedSyncPaths(deviceEntries, this.activeDeviceId);
    const desiredLocalPaths = new Set(localEntries.map((entry) => toRelativePath(entry.relativePath)));
    const syncOperations: SyncOperation[] = [];

    for (const entry of localEntries) {
      const relativePath = toRelativePath(entry.relativePath);
      if (!relativePath) {
        continue;
      }
      const isExcluded = this.isPathExcludedFromSync(relativePath, this.activeDeviceId);
      if (!entry.isDirectory && this.obfuscationSet.has(relativePath) && !isExcluded) {
        continue;
      }

      const deviceEntry = deviceEntryMap.get(relativePath);
      if (!deviceEntry) {
        const operation: Omit<SyncOperation, 'id'> = {
          action: 'create',
          relativePath,
          isDirectory: entry.isDirectory,
          excluded: isExcluded
        };
        syncOperations.push({ ...operation, id: this.toSyncOperationId(operation) });
        continue;
      }

      if (deviceEntry.isDirectory !== entry.isDirectory) {
        const operation: Omit<SyncOperation, 'id'> = {
          action: 'modify',
          relativePath,
          isDirectory: entry.isDirectory,
          excluded: isExcluded
        };
        syncOperations.push({ ...operation, id: this.toSyncOperationId(operation) });
        continue;
      }

      if (entry.isDirectory) {
        continue;
      }

      const needsWrite = !deviceEntry.sha1 || !entry.sha1 || deviceEntry.sha1 !== entry.sha1;
      if (needsWrite) {
        const operation: Omit<SyncOperation, 'id'> = {
          action: 'modify',
          relativePath,
          isDirectory: false,
          excluded: isExcluded
        };
        syncOperations.push({ ...operation, id: this.toSyncOperationId(operation) });
      }
    }

    for (const entry of deviceEntries) {
      const relativePath = toRelativePath(entry.relativePath);
      if (!relativePath) {
        continue;
      }
      if (desiredLocalPaths.has(relativePath)) {
        continue;
      }
      if (protectedDevicePaths.has(relativePath)) {
        if (this.isPathExcludedFromSync(relativePath, this.activeDeviceId)) {
          const operation: Omit<SyncOperation, 'id'> = {
            action: 'delete',
            relativePath,
            isDirectory: entry.isDirectory,
            excluded: true
          };
          syncOperations.push({ ...operation, id: this.toSyncOperationId(operation) });
        }
        continue;
      }
      const operation: Omit<SyncOperation, 'id'> = {
        action: 'delete',
        relativePath,
        isDirectory: entry.isDirectory,
        excluded: false
      };
      syncOperations.push({ ...operation, id: this.toSyncOperationId(operation) });
    }

    const syncDialog = await this.pickSyncOperations('Sync To Device Preview', syncOperations);
    if (!syncDialog) {
      vscode.window.showInformationMessage('Sync to device cancelled.');
      return;
    }

    const selectedOperations = syncOperations.filter((operation) => syncDialog.selectedIds.has(operation.id));
    const unselectedOperations = syncOperations.filter((operation) => !syncDialog.selectedIds.has(operation.id));
    for (const operation of unselectedOperations) {
      syncDialog.setStatus(operation.id, 'skipped');
    }
    let failedCount = 0;
    const staleDeviceEntries = selectedOperations
      .filter((operation) => operation.action === 'delete')
      .sort((a, b) => b.relativePath.length - a.relativePath.length);
    for (const operation of staleDeviceEntries) {
      syncDialog.setStatus(operation.id, 'in_progress');
      try {
        await deleteDevicePath(board, operation.relativePath);
        if (this.activeDeviceId) {
          await this.removeSyncExclusionsForDeletedDevicePath(this.activeDeviceId, operation.relativePath, operation.isDirectory);
        }
        if (this.notifyRemotePathDeleted) {
          await this.notifyRemotePathDeleted(operation.relativePath, operation.isDirectory);
        }
        syncDialog.setStatus(operation.id, 'success');
      } catch (error) {
        failedCount += 1;
        syncDialog.setStatus(operation.id, 'error', this.toErrorMessage(error));
      }
    }

    const localDirectories = selectedOperations
      .filter((operation) => operation.action !== 'delete' && operation.isDirectory)
      .sort((a, b) => a.relativePath.split('/').length - b.relativePath.split('/').length);
    for (const directory of localDirectories) {
      syncDialog.setStatus(directory.id, 'in_progress');
      try {
        await createDeviceDirectory(board, directory.relativePath);
        syncDialog.setStatus(directory.id, 'success');
      } catch (error) {
        failedCount += 1;
        syncDialog.setStatus(directory.id, 'error', this.toErrorMessage(error));
      }
    }

    const writtenDeviceFiles: string[] = [];
    const fileOperations = selectedOperations.filter((operation) => !operation.isDirectory && operation.action !== 'delete');
    for (const operation of fileOperations) {
      syncDialog.setStatus(operation.id, 'in_progress');
      try {
        const localEntry = localEntryMap.get(operation.relativePath);
        if (!localEntry || localEntry.isDirectory) {
          syncDialog.setStatus(operation.id, 'skipped');
          continue;
        }
        const localPath = path.join(this.mirrorRootPath, operation.relativePath);
        const content = await fs.readFile(localPath);
        await writeDeviceFile(board, operation.relativePath, Buffer.from(content));
        writtenDeviceFiles.push(operation.relativePath);
        syncDialog.setStatus(operation.id, 'success');
      } catch (error) {
        failedCount += 1;
        syncDialog.setStatus(operation.id, 'error', this.toErrorMessage(error));
      }
    }

    this.localEntries = localEntries;
    this.deviceEntries = await listDeviceEntries(board);
    this.syncStates = buildSyncStateMap(this.localEntries, this.deviceEntries, this.obfuscationSet);
    this.onDidChangeDataEmitter.fire();
    if (this.notifyRemoteFilesChanged) {
      await this.notifyRemoteFilesChanged(writtenDeviceFiles);
    }

    const msg = failedCount > 0
      ? `Sync to device finished with ${failedCount} error(s).`
      : 'Sync to device complete.';
    await syncDialog.finish(msg);
    vscode.window.showInformationMessage(msg);
    logChannelOutput(msg, true);
  }

  async syncNodeFromDevice(node?: MirrorNode): Promise<void> {
    const targetNode = this.resolveTargetNode(node);
    await this.ensureActiveDevice(targetNode);
    if (!targetNode || targetNode.data.isRoot || targetNode.data.isDeviceIdNode) {
      await this.syncFromDevice();
      return;
    }
    if (this.isNodeExcludedFromSync(targetNode)) {
      const excludedPath = targetNode ? toRelativePath(targetNode.data.relativePath) : '';
      vscode.window.showInformationMessage(`File is excluded from sync: /${excludedPath}`);
      return;
    }
    if (targetNode?.data.side === 'local') {
      await this.pullFromDevicePath(targetNode.data.relativePath, targetNode.data.isDirectory);
      return;
    }

    const relativePath = targetNode?.data.relativePath ?? '';
    const isDirectory = targetNode ? targetNode.data.isDirectory : true;
    await this.pullFromDevicePath(relativePath, isDirectory);
  }

  async syncNodeToDevice(node?: MirrorNode): Promise<void> {
    const targetNode = this.resolveTargetNode(node);
    await this.ensureActiveDevice(targetNode);
    if (!targetNode || targetNode.data.isRoot || targetNode.data.isDeviceIdNode) {
      await this.syncToDevice();
      return;
    }
    if (this.isNodeExcludedFromSync(targetNode)) {
      const excludedPath = targetNode ? toRelativePath(targetNode.data.relativePath) : '';
      vscode.window.showInformationMessage(`File is excluded from sync: /${excludedPath}`);
      return;
    }
    if (targetNode?.data.side === 'device') {
      await this.pushToDevicePath(targetNode.data.relativePath, targetNode.data.isDirectory);
      return;
    }

    const relativePath = targetNode?.data.relativePath ?? '';
    const isDirectory = targetNode ? targetNode.data.isDirectory : true;
    await this.pushToDevicePath(relativePath, isDirectory);
  }

  async createMirrorFile(node?: MirrorNode): Promise<void> {
    const targetNode = this.resolveTargetNode(node);
    await this.ensureActiveDevice(targetNode);
    if (targetNode?.data.side === 'device') {
      await this.createRemoteFile(targetNode);
      return;
    }

    await this.createLocalFile(targetNode);
  }

  async createMirrorFolder(node?: MirrorNode): Promise<void> {
    const targetNode = this.resolveTargetNode(node);
    await this.ensureActiveDevice(targetNode);
    if (targetNode?.data.side === 'device') {
      await this.createRemoteFolder(targetNode);
      return;
    }

    await this.createLocalFolder(targetNode);
  }

  async renameMirrorPath(node?: MirrorNode): Promise<void> {
    const targetNode = this.resolveTargetNode(node);
    await this.ensureActiveDevice(targetNode);
    if (!targetNode || targetNode.data.isRoot || targetNode.data.isIndicator) {
      vscode.window.showWarningMessage('Select a file or folder to rename.');
      return;
    }

    if (targetNode.data.side === 'device') {
      await this.renameRemotePath(targetNode);
      return;
    }

    await this.renameLocalPath(targetNode);
  }

  async deleteMirrorPath(node?: MirrorNode): Promise<void> {
    const targetNode = this.resolveTargetNode(node);
    await this.ensureActiveDevice(targetNode);
    if (!targetNode || targetNode.data.isRoot || targetNode.data.isIndicator) {
      vscode.window.showWarningMessage('Select a file or folder to delete.');
      return;
    }

    if (targetNode.data.side === 'device') {
      await this.deleteRemotePath(targetNode);
      return;
    }

    await this.deleteLocalPath(targetNode);
  }

  async openLocalNode(node: MirrorNode): Promise<void> {
    await this.ensureActiveDevice(node);
    const localRootPath = this.resolveLocalReadRootPath(node);
    if (!localRootPath) {
      return;
    }

    const fullPath = path.join(localRootPath, node.data.relativePath);
    const stat = await fs.stat(fullPath);
    if (stat.isDirectory()) {
      return;
    }

    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(fullPath));
    await vscode.window.showTextDocument(document, { preview: false });
  }

  async pullDeviceNodeAndOpen(node: MirrorNode): Promise<void> {
    await this.ensureActiveDevice(node);
    if (!getConnectedBoard(this.activeDeviceId)) {
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
    const deviceSegment = encodeURIComponent(this.activeDeviceId ?? '');
    const remoteUri = vscode.Uri.parse(`${remoteDocumentScheme}:/${deviceSegment}/${relativePath}`);
    const document = await vscode.workspace.openTextDocument(remoteUri);
    await vscode.window.showTextDocument(document, { preview: false });
  }

  async openRemoteFile(node?: MirrorNode): Promise<void> {
    await this.ensureActiveDevice(node);
    if (node) {
      await this.pullDeviceNodeAndOpen(node);
      return;
    }

    const board = getConnectedBoard(this.activeDeviceId);
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
        isDirectory: false,
        deviceId: this.activeDeviceId
      },
      selected.label,
      vscode.TreeItemCollapsibleState.None
    );

    await this.pullDeviceNodeAndOpen(quickPickNode);
  }

  async compareRemoteWithLocal(node?: MirrorNode): Promise<void> {
    const targetNode = this.resolveTargetNode(node);
    await this.ensureActiveDevice(targetNode);
    if (targetNode) {
      await this.openRemoteDiff(targetNode);
      return;
    }

    const board = getConnectedBoard(this.activeDeviceId);
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
        isDirectory: false,
        deviceId: this.activeDeviceId
      },
      selected.label,
      vscode.TreeItemCollapsibleState.None
    );

    await this.openRemoteDiff(quickPickNode);
  }

  async createRemoteFile(node?: MirrorNode): Promise<void> {
    await this.ensureActiveDevice(node);
    const board = getConnectedBoard(this.activeDeviceId);
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
    const createdNode = new MirrorNode(
      {
        side: 'device',
        relativePath,
        isDirectory: false,
        deviceId: this.activeDeviceId
      },
      path.posix.basename(relativePath),
      vscode.TreeItemCollapsibleState.None
    );
    await this.pullDeviceNodeAndOpen(createdNode);

    const msg = `Created remote file: /${relativePath}`;
    vscode.window.showInformationMessage(msg);
    logChannelOutput(msg, true);
  }

  async createRemoteFolder(node?: MirrorNode): Promise<void> {
    await this.ensureActiveDevice(node);
    const board = getConnectedBoard(this.activeDeviceId);
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
    node = this.resolveTargetNode(node);
    await this.ensureActiveDevice(node);
    if (!node || node.data.side !== 'device') {
      vscode.window.showWarningMessage('Select a remote file or folder to rename.');
      return;
    }

    const board = getConnectedBoard(this.activeDeviceId);
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
    node = this.resolveTargetNode(node);
    await this.ensureActiveDevice(node);
    if (!node || node.data.side !== 'device') {
      vscode.window.showWarningMessage('Select a remote file or folder to delete.');
      return;
    }

    const board = getConnectedBoard(this.activeDeviceId);
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
    if (this.activeDeviceId) {
      await this.removeSyncExclusionsForDeletedDevicePath(this.activeDeviceId, targetPath, node.data.isDirectory);
    }
    if (this.notifyRemotePathDeleted) {
      await this.notifyRemotePathDeleted(targetPath, node.data.isDirectory);
    }
    await this.refresh(true);

    const msg = `Deleted remote path: /${targetPath}`;
    vscode.window.showInformationMessage(msg);
    logChannelOutput(msg, true);
  }

  private resolveTargetNode(node?: MirrorNode): MirrorNode | undefined {
    return node ?? this.selectedNode;
  }

  private matchesTarget(entryPath: string, targetPath: string, includeDescendants: boolean): boolean {
    if (!targetPath) {
      return true;
    }

    if (entryPath === targetPath) {
      return true;
    }

    if (!includeDescendants) {
      return false;
    }

    return entryPath.startsWith(`${targetPath}/`);
  }

  private toSyncOperationId(operation: Omit<SyncOperation, 'id'>): string {
    const type = operation.isDirectory ? 'dir' : 'file';
    const excluded = operation.excluded ? 'excluded' : 'included';
    return `${operation.action}:${type}:${excluded}:${operation.relativePath}`;
  }

  private async pickSyncOperations(
    title: string,
    operations: SyncOperation[]
  ): Promise<SyncOperationsDialog | undefined> {
    const rows = operations
      .sort((a, b) => {
        if (a.relativePath === b.relativePath) {
          return a.action.localeCompare(b.action);
        }
        return a.relativePath.localeCompare(b.relativePath);
      })
      .map((operation) => ({
        id: operation.id,
        action: operation.action,
        actionIcon: operation.action === 'create' ? '+' : (operation.action === 'modify' ? '~' : '-'),
        relativePath: operation.relativePath,
        isDirectory: operation.isDirectory,
        excluded: operation.excluded,
        checked: !operation.excluded
      }));

    const panel = vscode.window.createWebviewPanel(
      'pyboarddev.syncPreview',
      title,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true }
    );

    const rowsJson = JSON.stringify(rows);
    const titleText = this.escapeHtml(title);
    panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${titleText}</title>
  <style>
    :root { color-scheme: light dark; }
    body { margin: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); }
    .wrap { max-width: 1100px; margin: 28px auto; padding: 0 20px 20px; }
    h2 { margin: 0 0 10px; font-size: 16px; }
    .hint { margin: 0 0 12px; opacity: 0.9; }
    table { width: 100%; border-collapse: collapse; border: 1px solid var(--vscode-editorWidget-border); table-layout: fixed; }
    th, td { padding: 8px 10px; border-bottom: 1px solid var(--vscode-editorWidget-border); vertical-align: middle; }
    th { text-align: left; font-weight: 600; }
    th.check, td.check { width: 48px; text-align: center; }
    th.action, td.action { width: 90px; text-align: center; }
    th.status, td.status { width: 120px; }
    th.error, td.error { width: 280px; }
    td.path { font-family: var(--vscode-editor-font-family); font-size: 12px; }
    td.note { color: var(--vscode-descriptionForeground); }
    td.error { color: var(--vscode-errorForeground); }
    .status-pending { color: var(--vscode-descriptionForeground); }
    .status-in_progress { color: var(--vscode-charts-blue); }
    .status-success { color: var(--vscode-charts-green); }
    .status-skipped { color: var(--vscode-descriptionForeground); }
    .status-error { color: var(--vscode-errorForeground); }
    .action-create { color: var(--vscode-charts-green); font-weight: 700; }
    .action-modify { color: var(--vscode-charts-blue); font-weight: 700; }
    .action-delete { color: var(--vscode-charts-red); font-weight: 700; }
    .empty { padding: 20px; text-align: center; color: var(--vscode-descriptionForeground); }
    .buttons { display: flex; justify-content: flex-end; gap: 10px; margin-top: 12px; }
    button {
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      padding: 6px 14px;
      cursor: pointer;
    }
    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    input[type="checkbox"] { transform: scale(1.1); cursor: pointer; }
  </style>
</head>
<body>
  <div class="wrap">
    <h2>${titleText}</h2>
    <p class="hint">Unchecking a folder unchecks all children. Checking a folder does not auto-check children.</p>
    <table>
      <thead>
        <tr>
          <th class="check"></th>
          <th class="action">Action</th>
          <th>Path</th>
          <th></th>
          <th class="status">Status</th>
          <th class="error"></th>
        </tr>
      </thead>
      <tbody id="rows"></tbody>
    </table>
    <div class="buttons">
      <button id="cancel" class="secondary">Cancel</button>
      <button id="continue">Continue</button>
      <button id="close" class="secondary" style="display:none">Close</button>
    </div>
    <p id="summary" class="hint" style="display:none; margin-top:12px;"></p>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const rows = ${rowsJson};
    const tbody = document.getElementById('rows');
    const toClass = (action) => action === 'create' ? 'action-create' : (action === 'modify' ? 'action-modify' : 'action-delete');
    const noteText = 'this path is configured to be excluded by default';

    if (rows.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 6;
      td.className = 'empty';
      td.textContent = 'Nothing needs synchronisation';
      tr.appendChild(td);
      tbody.appendChild(tr);
    } else {
      for (const row of rows) {
        const tr = document.createElement('tr');
        tr.dataset.path = row.relativePath;

        const checkTd = document.createElement('td');
        checkTd.className = 'check';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = !!row.checked;
        checkbox.dataset.id = row.id;
        checkbox.dataset.path = row.relativePath;
        checkbox.dataset.dir = row.isDirectory ? 'true' : 'false';
        checkTd.appendChild(checkbox);
        tr.appendChild(checkTd);

        const actionTd = document.createElement('td');
        actionTd.className = 'action';
        const actionSpan = document.createElement('span');
        actionSpan.className = toClass(row.action);
        actionSpan.textContent = row.actionIcon;
        actionSpan.title = row.action;
        actionTd.appendChild(actionSpan);
        tr.appendChild(actionTd);

        const pathTd = document.createElement('td');
        pathTd.className = 'path';
        pathTd.textContent = row.relativePath;
        tr.appendChild(pathTd);

        const noteTd = document.createElement('td');
        noteTd.className = 'note';
        noteTd.textContent = row.excluded ? noteText : '';
        tr.appendChild(noteTd);

        const statusTd = document.createElement('td');
        statusTd.className = 'status status-pending';
        statusTd.textContent = row.checked ? 'pending' : 'skipped';
        statusTd.dataset.status = 'pending';
        statusTd.dataset.id = row.id;
        tr.appendChild(statusTd);

        const errorTd = document.createElement('td');
        errorTd.className = 'error';
        errorTd.textContent = '';
        errorTd.dataset.id = row.id;
        tr.appendChild(errorTd);

        tbody.appendChild(tr);
      }
    }

    const isDescendant = (child, parent) => parent && child.startsWith(parent + '/');
    const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"][data-id]'));
    for (const checkbox of checkboxes) {
      checkbox.addEventListener('change', () => {
        if (checkbox.dataset.dir === 'true' && checkbox.checked === false) {
          const parentPath = checkbox.dataset.path || '';
          for (const other of checkboxes) {
            if (other === checkbox) continue;
            const childPath = other.dataset.path || '';
            if (isDescendant(childPath, parentPath)) {
              other.checked = false;
            }
          }
        }
        const id = checkbox.dataset.id;
        const statusCell = document.querySelector('td.status[data-id="' + id + '"]');
        if (statusCell) {
          statusCell.textContent = checkbox.checked ? 'pending' : 'skipped';
          statusCell.className = 'status ' + (checkbox.checked ? 'status-pending' : 'status-skipped');
        }
      });
    }

    document.getElementById('continue').addEventListener('click', () => {
      const selectedIds = checkboxes.filter((cb) => cb.checked).map((cb) => cb.dataset.id);
      vscode.postMessage({ type: 'continue', selectedIds });
    });

    document.getElementById('cancel').addEventListener('click', () => {
      vscode.postMessage({ type: 'cancel' });
    });

    document.getElementById('close').addEventListener('click', () => {
      vscode.postMessage({ type: 'close' });
    });

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (!message || typeof message !== 'object') {
        return;
      }

      if (message.type === 'lock') {
        for (const checkbox of checkboxes) {
          checkbox.disabled = true;
        }
        document.getElementById('continue').disabled = true;
        document.getElementById('cancel').disabled = true;
      }

      if (message.type === 'update') {
        const statusCell = document.querySelector('td.status[data-id="' + message.id + '"]');
        const errorCell = document.querySelector('td.error[data-id="' + message.id + '"]');
        if (statusCell) {
          statusCell.textContent = message.status;
          statusCell.className = 'status status-' + message.status;
        }
        if (errorCell) {
          errorCell.textContent = message.errorText || '';
        }
      }

      if (message.type === 'finish') {
        const summary = document.getElementById('summary');
        summary.textContent = message.summary || '';
        summary.style.display = 'block';
        document.getElementById('continue').style.display = 'none';
        document.getElementById('cancel').style.display = 'none';
        document.getElementById('close').style.display = 'inline-block';
      }
    });
  </script>
</body>
</html>`;

    const selectedIds = await new Promise<Set<string> | undefined>((resolve) => {
      let resolved = false;
      const settle = (value: Set<string> | undefined): void => {
        if (resolved) {
          return;
        }
        resolved = true;
        resolve(value);
      };

      panel.onDidDispose(() => settle(undefined));
      panel.webview.onDidReceiveMessage((message: unknown) => {
        if (!message || typeof message !== 'object') {
          return;
        }
        const typed = message as { type?: string; selectedIds?: unknown };
        if (typed.type === 'cancel') {
          panel.dispose();
          settle(undefined);
          return;
        }
        if (typed.type === 'continue') {
          const selected = Array.isArray(typed.selectedIds)
            ? typed.selectedIds.filter((item): item is string => typeof item === 'string')
            : [];
          void panel.webview.postMessage({ type: 'lock' });
          settle(new Set(selected));
        }
      });
    });
    if (!selectedIds) {
      return undefined;
    }

    return {
      selectedIds,
      setStatus: (operationId: string, status: SyncOperationRunStatus, errorText?: string) => {
        void panel.webview.postMessage({ type: 'update', id: operationId, status, errorText });
      },
      finish: async (summary: string) => {
        void panel.webview.postMessage({ type: 'finish', summary });
        await new Promise<void>((resolve) => {
          let settled = false;
          const settle = (): void => {
            if (settled) {
              return;
            }
            settled = true;
            resolve();
          };
          panel.onDidDispose(() => settle());
          panel.webview.onDidReceiveMessage((message: unknown) => {
            if (!message || typeof message !== 'object') {
              return;
            }
            const typed = message as { type?: string };
            if (typed.type === 'close') {
              panel.dispose();
              settle();
            }
          });
        });
      }
    };
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private toErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }

  private getDeviceSyncExclusionSet(deviceId?: string): Set<string> {
    if (!deviceId) {
      return new Set();
    }
    return this.deviceSyncExcludedPaths[deviceId] ?? new Set();
  }

  private isPathExcludedFromSync(relativePath: string, deviceId?: string): boolean {
    const normalised = toRelativePath(relativePath);
    if (!normalised) {
      return false;
    }
    const excludedPaths = this.getDeviceSyncExclusionSet(deviceId);
    if (excludedPaths.has(normalised)) {
      return true;
    }
    let parent = path.posix.dirname(normalised);
    while (parent && parent !== '.') {
      const parentPath = toRelativePath(parent);
      if (excludedPaths.has(parentPath)) {
        return true;
      }
      parent = path.posix.dirname(parent);
    }
    return false;
  }

  private isPathDirectlyExcludedFromSync(relativePath: string, deviceId?: string): boolean {
    const normalised = toRelativePath(relativePath);
    if (!normalised) {
      return false;
    }
    return this.getDeviceSyncExclusionSet(deviceId).has(normalised);
  }

  private findNearestExcludedPath(relativePath: string, deviceId?: string): string | undefined {
    const normalised = toRelativePath(relativePath);
    if (!normalised) {
      return undefined;
    }
    const excludedPaths = this.getDeviceSyncExclusionSet(deviceId);
    if (excludedPaths.has(normalised)) {
      return normalised;
    }
    let parent = path.posix.dirname(normalised);
    while (parent && parent !== '.') {
      const parentPath = toRelativePath(parent);
      if (excludedPaths.has(parentPath)) {
        return parentPath;
      }
      parent = path.posix.dirname(parent);
    }
    return undefined;
  }

  private getProtectedSyncPaths(
    destinationEntries: FileEntry[],
    deviceId?: string
  ): Set<string> {
    const protectedPaths = new Set<string>();
    const excludedPaths = this.getDeviceSyncExclusionSet(deviceId);
    if (excludedPaths.size === 0) {
      return protectedPaths;
    }

    const existingPaths = new Set(
      destinationEntries
        .map((entry) => toRelativePath(entry.relativePath))
        .filter((entryPath) => entryPath.length > 0)
    );

    for (const excludedPath of excludedPaths) {
      const matchingPaths = [...existingPaths].filter((existingPath) =>
        existingPath === excludedPath || existingPath.startsWith(`${excludedPath}/`)
      );
      if (matchingPaths.length === 0) {
        continue;
      }

      for (const matchingPath of matchingPaths) {
        protectedPaths.add(matchingPath);
        let parent = path.posix.dirname(matchingPath);
        while (parent && parent !== '.') {
          protectedPaths.add(toRelativePath(parent));
          parent = path.posix.dirname(parent);
        }
      }
    }

    return protectedPaths;
  }

  private async pruneMissingDeviceSyncExclusions(deviceId: string, deviceEntries: FileEntry[]): Promise<void> {
    const current = this.deviceSyncExcludedPaths[deviceId];
    if (!current || current.size === 0) {
      return;
    }

    const existingPaths = new Set(
      deviceEntries
        .map((entry) => toRelativePath(entry.relativePath))
        .filter((relativePath) => relativePath.length > 0)
    );
    const nextPaths = [...current].filter((relativePath) =>
      existingPaths.has(relativePath) || [...existingPaths].some((existingPath) => existingPath.startsWith(`${relativePath}/`))
    );
    if (nextPaths.length === current.size) {
      return;
    }

    const updated = await updateDeviceSyncExcludedPaths(deviceId, nextPaths);
    this.deviceSyncExcludedPaths = Object.fromEntries(
      Object.entries(getDeviceSyncExcludedPaths(updated)).map(([id, relativePaths]) => [id, new Set(relativePaths)])
    );
  }

  private async removeSyncExclusionsForDeletedDevicePath(deviceId: string, deletedPath: string, includeDescendants: boolean): Promise<void> {
    const normalisedDeletedPath = toRelativePath(deletedPath);
    if (!normalisedDeletedPath) {
      return;
    }

    const current = this.deviceSyncExcludedPaths[deviceId];
    if (!current || current.size === 0) {
      return;
    }

    const nextPaths = [...current].filter((relativePath) => {
      if (relativePath === normalisedDeletedPath) {
        return false;
      }
      if (includeDescendants && relativePath.startsWith(`${normalisedDeletedPath}/`)) {
        return false;
      }
      return true;
    });
    if (nextPaths.length === current.size) {
      return;
    }

    const updated = await updateDeviceSyncExcludedPaths(deviceId, nextPaths);
    this.deviceSyncExcludedPaths = Object.fromEntries(
      Object.entries(getDeviceSyncExcludedPaths(updated)).map(([id, relativePaths]) => [id, new Set(relativePaths)])
    );
  }

  private isNodeExcludedFromSync(node: MirrorNode | undefined): boolean {
    if (!node || node.data.isRoot || node.data.isIndicator) {
      return false;
    }

    const deviceId = this.getNodeDeviceId(node);
    return this.isPathExcludedFromSync(node.data.relativePath, deviceId);
  }

  isNodePathExcludedFromSync(data: NodeData): boolean {
    if (data.isRoot || data.isIndicator) {
      return false;
    }

    const deviceId = data.deviceId ?? this.activeDeviceId;
    return this.isPathExcludedFromSync(data.relativePath, deviceId);
  }

  async excludeDeviceFileFromSync(node?: MirrorNode): Promise<void> {
    const targetNode = this.resolveTargetNode(node);
    await this.ensureActiveDevice(targetNode);
    if (!targetNode || targetNode.data.isRoot || targetNode.data.isIndicator) {
      vscode.window.showWarningMessage('Select a file or folder to exclude from sync.');
      return;
    }

    const deviceId = this.getNodeDeviceId(targetNode);
    if (!deviceId) {
      vscode.window.showWarningMessage('Select a linked device path to exclude from sync.');
      return;
    }

    const relativePath = toRelativePath(targetNode.data.relativePath);
    if (!relativePath) {
      vscode.window.showWarningMessage('Select a file or folder to exclude from sync.');
      return;
    }

    if (this.isPathExcludedFromSync(relativePath, deviceId)) {
      vscode.window.showInformationMessage(`Already excluded from sync: /${relativePath}`);
      return;
    }

    await updateDeviceSyncExclusion(deviceId, relativePath, true);
    await this.refresh(false);

    const msg = `Excluded from sync for ${this.getDeviceDisplayNameWithId(deviceId)}: /${relativePath}`;
    vscode.window.showInformationMessage(msg);
    logChannelOutput(msg, true);
  }

  async removeDeviceFileFromSyncExclusion(node?: MirrorNode): Promise<void> {
    const targetNode = this.resolveTargetNode(node);
    await this.ensureActiveDevice(targetNode);
    if (!targetNode || targetNode.data.isRoot || targetNode.data.isIndicator) {
      vscode.window.showWarningMessage('Select an excluded file or folder to remove from sync exclusions.');
      return;
    }

    const deviceId = this.getNodeDeviceId(targetNode);
    if (!deviceId) {
      vscode.window.showWarningMessage('Select a linked device path to update sync exclusions.');
      return;
    }

    const relativePath = toRelativePath(targetNode.data.relativePath);
    if (!relativePath) {
      vscode.window.showWarningMessage('Select an excluded file or folder to remove from sync exclusions.');
      return;
    }

    const exclusionPath = this.findNearestExcludedPath(relativePath, deviceId);
    if (!exclusionPath) {
      vscode.window.showInformationMessage(`Path is not excluded from sync: /${relativePath}`);
      return;
    }

    await updateDeviceSyncExclusion(deviceId, exclusionPath, false);
    await this.refresh(false);

    const msg = `Removed sync exclusion for ${this.getDeviceDisplayNameWithId(deviceId)}: /${exclusionPath}`;
    vscode.window.showInformationMessage(msg);
    logChannelOutput(msg, true);
  }

  private async pullFromDevicePath(targetPath: string, includeDescendants: boolean): Promise<void> {
    await this.ensureActiveDevice();
    if (!this.workspaceFolder || !this.mirrorRootPath) {
      await this.refresh(false);
    }

    const board = getConnectedBoard(this.activeDeviceId);
    if (!board) {
      vscode.window.showWarningMessage('Connect to a board before syncing from device.');
      return;
    }

    if (!this.mirrorRootPath) {
      vscode.window.showWarningMessage('Link this device to a host folder before syncing from device.');
      return;
    }

    const normalisedTarget = toRelativePath(targetPath);
    const deviceEntries = await listDeviceEntries(board);
    const scopedEntries = deviceEntries.filter(
      (entry) => entry.relativePath.length > 0 && this.matchesTarget(entry.relativePath, normalisedTarget, includeDescendants)
    );
    const desiredPaths = new Set(scopedEntries.map((entry) => entry.relativePath));

    const existingLocalEntries = await scanLocalMirrorEntries(this.mirrorRootPath);
    const protectedLocalPaths = this.getProtectedSyncPaths(existingLocalEntries, this.activeDeviceId);
    const staleLocalEntries = existingLocalEntries
      .filter(
        (entry) =>
          entry.relativePath.length > 0 &&
          this.matchesTarget(entry.relativePath, normalisedTarget, includeDescendants) &&
          !desiredPaths.has(entry.relativePath) &&
          !protectedLocalPaths.has(entry.relativePath)
      )
      .sort((a, b) => b.relativePath.length - a.relativePath.length);
    for (const staleEntry of staleLocalEntries) {
      const stalePath = path.join(this.mirrorRootPath, staleEntry.relativePath);
      await fs.rm(stalePath, { recursive: true, force: true });
    }

    for (const entry of scopedEntries) {
      if (this.isPathExcludedFromSync(entry.relativePath, this.activeDeviceId)) {
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

    const targetLabel = normalisedTarget ? `/${normalisedTarget}` : '/';
    const msg = `Sync from device complete for ${targetLabel}.`;
    vscode.window.showInformationMessage(msg);
    logChannelOutput(msg, true);
  }

  private async pushToDevicePath(targetPath: string, includeDescendants: boolean): Promise<void> {
    await this.ensureActiveDevice();
    if (!this.workspaceFolder || !this.mirrorRootPath) {
      await this.refresh(false);
    }

    const board = getConnectedBoard(this.activeDeviceId);
    if (!board) {
      vscode.window.showWarningMessage('Connect to a board before syncing to device.');
      return;
    }

    if (!this.mirrorRootPath) {
      vscode.window.showWarningMessage('Link this device to a host folder before syncing to device.');
      return;
    }

    const normalisedTarget = toRelativePath(targetPath);
    const localEntries = await scanLocalMirrorEntries(this.mirrorRootPath);
    const deviceEntries = await listDeviceEntries(board);
    const protectedDevicePaths = this.getProtectedSyncPaths(deviceEntries, this.activeDeviceId);
    const scopedEntries = localEntries.filter(
      (entry) => entry.relativePath.length > 0 && this.matchesTarget(entry.relativePath, normalisedTarget, includeDescendants)
    );
    const scopedDeviceEntries = deviceEntries.filter(
      (entry) => entry.relativePath.length > 0 && this.matchesTarget(entry.relativePath, normalisedTarget, includeDescendants)
    );
    const desiredLocalPaths = new Set(scopedEntries.map((entry) => entry.relativePath));
    const staleDeviceEntries = scopedDeviceEntries
      .filter((entry) => {
        if (desiredLocalPaths.has(entry.relativePath)) {
          return false;
        }
        if (protectedDevicePaths.has(entry.relativePath)) {
          return false;
        }
        return true;
      })
      .sort((a, b) => b.relativePath.length - a.relativePath.length);
    for (const staleEntry of staleDeviceEntries) {
      await deleteDevicePath(board, staleEntry.relativePath);
      if (this.activeDeviceId) {
        await this.removeSyncExclusionsForDeletedDevicePath(this.activeDeviceId, staleEntry.relativePath, staleEntry.isDirectory);
      }
      if (this.notifyRemotePathDeleted) {
        await this.notifyRemotePathDeleted(staleEntry.relativePath, staleEntry.isDirectory);
      }
    }

    const localDirectories = scopedEntries
      .filter((entry) => entry.isDirectory)
      .sort((a, b) => a.relativePath.split('/').length - b.relativePath.split('/').length);
    for (const directory of localDirectories) {
      await createDeviceDirectory(board, directory.relativePath);
    }

    const writtenDeviceFiles: string[] = [];
    for (const entry of scopedEntries) {
      if (entry.isDirectory) {
        continue;
      }
      if (this.isPathExcludedFromSync(entry.relativePath, this.activeDeviceId)) {
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

    const targetLabel = normalisedTarget ? `/${normalisedTarget}` : '/';
    const msg = `Sync to device complete for ${targetLabel}.`;
    vscode.window.showInformationMessage(msg);
    logChannelOutput(msg, true);
  }

  private getLocalParentPath(node?: MirrorNode): string {
    if (!node || node.data.side !== 'local' || node.data.isRoot) {
      return '';
    }

    if (node.data.isDirectory) {
      return toRelativePath(node.data.relativePath);
    }

    const parent = path.posix.dirname(node.data.relativePath);
    return parent === '.' ? '' : toRelativePath(parent);
  }

  private validateLocalName(value: string): string | undefined {
    const trimmed = value.trim();
    if (!trimmed) {
      return 'Name is required.';
    }
    if (trimmed.includes('/') || trimmed.includes('\\')) {
      return 'Use a single name, not a path.';
    }
    if (trimmed === '.' || trimmed === '..') {
      return 'Invalid name.';
    }
    return undefined;
  }

  private async resolveLocalWriteRootPath(): Promise<string | undefined> {
    if (this.mirrorRootPath) {
      return this.mirrorRootPath;
    }

    const hostRootPath = this.getHostMirrorRootPath();
    if (!hostRootPath) {
      return undefined;
    }
    await fs.mkdir(hostRootPath, { recursive: true });
    return hostRootPath;
  }

  private resolveLocalReadRootPath(node?: MirrorNode): string | undefined {
    if (node?.data.deviceId) {
      return this.mirrorRootByDeviceId.get(node.data.deviceId) ?? this.mirrorRootPath;
    }

    if (this.mirrorRootPath) {
      return this.mirrorRootPath;
    }

    return this.getHostMirrorRootPath();
  }

  private async createLocalFile(node?: MirrorNode): Promise<void> {
    const localRootPath = await this.resolveLocalWriteRootPath();
    if (!localRootPath) {
      vscode.window.showWarningMessage('Open a workspace before creating host files.');
      return;
    }

    const parentPath = this.getLocalParentPath(node);
    const fileName = await vscode.window.showInputBox({
      title: 'Create Host File',
      prompt: parentPath ? `Create in /${parentPath}` : 'Create in /',
      placeHolder: 'filename.py',
      ignoreFocusOut: true,
      validateInput: (value) => this.validateLocalName(value)
    });

    if (!fileName) {
      return;
    }

    const relativePath = this.joinRemotePath(parentPath, fileName);
    const absolutePath = path.join(localRootPath, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, Buffer.alloc(0));
    await this.refresh(false);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(absolutePath));
    await vscode.window.showTextDocument(document, { preview: false });

    const msg = `Created host file: /${relativePath}`;
    vscode.window.showInformationMessage(msg);
    logChannelOutput(msg, true);
  }

  private async createLocalFolder(node?: MirrorNode): Promise<void> {
    const localRootPath = await this.resolveLocalWriteRootPath();
    if (!localRootPath) {
      vscode.window.showWarningMessage('Open a workspace before creating host folders.');
      return;
    }

    const parentPath = this.getLocalParentPath(node);
    const folderName = await vscode.window.showInputBox({
      title: 'Create Host Folder',
      prompt: parentPath ? `Create in /${parentPath}` : 'Create in /',
      placeHolder: 'folder',
      ignoreFocusOut: true,
      validateInput: (value) => this.validateLocalName(value)
    });

    if (!folderName) {
      return;
    }

    const relativePath = this.joinRemotePath(parentPath, folderName);
    const absolutePath = path.join(localRootPath, relativePath);
    await fs.mkdir(absolutePath, { recursive: true });
    await this.refresh(false);

    const msg = `Created host folder: /${relativePath}`;
    vscode.window.showInformationMessage(msg);
    logChannelOutput(msg, true);
  }

  private async renameLocalPath(node: MirrorNode): Promise<void> {
    const localRootPath = this.resolveLocalReadRootPath(node);
    if (!localRootPath) {
      vscode.window.showWarningMessage('Open a workspace before renaming host items.');
      return;
    }

    const currentPath = toRelativePath(node.data.relativePath);
    const currentName = path.posix.basename(currentPath);
    const parentPath = path.posix.dirname(currentPath) === '.' ? '' : path.posix.dirname(currentPath);
    const nextName = await vscode.window.showInputBox({
      title: `Rename Host ${node.data.isDirectory ? 'Folder' : 'File'}`,
      prompt: `Current: /${currentPath}`,
      value: currentName,
      ignoreFocusOut: true,
      validateInput: (value) => this.validateLocalName(value)
    });

    if (!nextName || nextName === currentName) {
      return;
    }

    const nextPath = this.joinRemotePath(parentPath, nextName);
    await fs.rename(path.join(localRootPath, currentPath), path.join(localRootPath, nextPath));
    await this.refresh(false);

    const msg = `Renamed host path: /${currentPath} -> /${nextPath}`;
    vscode.window.showInformationMessage(msg);
    logChannelOutput(msg, true);
  }

  private async deleteLocalPath(node: MirrorNode): Promise<void> {
    const localRootPath = this.resolveLocalReadRootPath(node);
    if (!localRootPath) {
      vscode.window.showWarningMessage('Open a workspace before deleting host items.');
      return;
    }

    const targetPath = toRelativePath(node.data.relativePath);
    const action = await vscode.window.showWarningMessage(
      `Delete host ${node.data.isDirectory ? 'folder' : 'file'} "/${targetPath}"?`,
      { modal: true },
      'Delete'
    );
    if (action !== 'Delete') {
      return;
    }

    await fs.rm(path.join(localRootPath, targetPath), { recursive: true, force: true });
    await this.refresh(false);

    const msg = `Deleted host path: /${targetPath}`;
    vscode.window.showInformationMessage(msg);
    logChannelOutput(msg, true);
  }

  getNodeChildren(side: NodeSide, parentRelativePath: string, deviceId?: string): MirrorNode[] {
    this.activateDevice(deviceId ?? this.activeDeviceId);
    const sourceEntries = side === 'device'
      ? this.deviceEntries
      : (deviceId ? this.localEntries : this.unlinkedHostEntries);
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
            isDirectory: entry.isDirectory,
            deviceId
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
    return getConnectedBoards().length > 0;
  }

  getMirrorRootPath(): string | undefined {
    return this.mirrorRootPath;
  }

  getActiveDeviceId(): string | undefined {
    return this.activeDeviceId;
  }

  getKnownDeviceIds(): string[] {
    return [...this.knownDeviceIds].sort((a, b) => a.localeCompare(b));
  }

  getLinkedHostDeviceIds(): string[] {
    return Object.keys(this.deviceHostFolderMappings).sort((a, b) => a.localeCompare(b));
  }

  getLinkedHostFolderCount(): number {
    return new Set(
      Object.values(this.deviceHostFolderMappings)
        .map((item) => toRelativePath(item))
        .filter((item) => item.length > 0)
    ).size;
  }

  getAvailableHostFolderCount(): number {
    return this.linkableHostFolders.length;
  }

  getAvailableHostFolders(): string[] {
    return [...this.linkableHostFolders];
  }

  getConnectedDeviceIds(): string[] {
    return getConnectedBoards().map((item) => item.deviceId).sort((a, b) => a.localeCompare(b));
  }

  getConnectedDevice(deviceId: string): ReturnType<typeof getConnectedBoards>[number] | undefined {
    return getConnectedBoards().find((item) => item.deviceId === deviceId);
  }

  getMappedHostFolder(deviceId: string): string | undefined {
    return this.deviceHostFolderMappings[deviceId];
  }

  getDeviceAlias(deviceId: string): string | undefined {
    const alias = this.deviceAliases[deviceId];
    if (!alias) {
      return undefined;
    }
    const trimmed = alias.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  getDeviceDisplayName(deviceId: string): string {
    return this.getDeviceAlias(deviceId) ?? deviceId;
  }

  getDeviceDisplayNameWithId(deviceId: string): string {
    const alias = this.getDeviceAlias(deviceId);
    return alias ? `${alias} (${deviceId})` : deviceId;
  }

  async linkDeviceToHostFolder(node?: MirrorNode): Promise<void> {
    let deviceId = await this.ensureActiveDevice(node);
    if (!deviceId) {
      deviceId = await this.pickKnownDeviceId('Select device to link');
      if (deviceId) {
        this.activateDevice(deviceId);
      }
    }
    if (!deviceId || !this.workspaceFolder) {
      vscode.window.showWarningMessage('Select a device to link.');
      return;
    }

    const folderOptions = this.linkableHostFolders.map((folder) => {
      const leafName = path.posix.basename(toRelativePath(folder));
      return {
        label: leafName,
        description: folder,
        relativePath: folder
      };
    });

    if (folderOptions.length === 0) {
      vscode.window.showWarningMessage(`No host folders available under ${hostMirrorRootFolder}/.`);
      return;
    }

    const picked = await vscode.window.showQuickPick(folderOptions, {
      title: 'Link Device to Host Folder',
      placeHolder: `Select host folder for ${deviceId}`,
      canPickMany: false,
      ignoreFocusOut: true
    });
    if (!picked) {
      return;
    }

    const normalised = picked.relativePath;

    const updated = await updateDeviceHostFolderMapping(deviceId, normalised);
    this.deviceHostFolderMappings = getDeviceHostFolderMappings(updated);

    const msg = `Linked ${deviceId} to host folder: ${normalised}`;
    logChannelOutput(msg, true);
    vscode.window.showInformationMessage(msg);
    await this.refresh(true);
  }

  async unlinkDeviceFromHostFolder(node?: MirrorNode): Promise<void> {
    let deviceId = await this.ensureActiveDevice(node);
    if (!deviceId) {
      deviceId = await this.pickKnownDeviceId('Select device to unlink');
      if (deviceId) {
        this.activateDevice(deviceId);
      }
    }
    if (!deviceId) {
      vscode.window.showWarningMessage('Select a device to unlink.');
      return;
    }

    const current = this.getMappedHostFolder(deviceId);
    if (!current) {
      vscode.window.showInformationMessage(`No host folder link exists for ${deviceId}.`);
      return;
    }

    const action = await vscode.window.showWarningMessage(
      `Unlink ${deviceId} from host folder "${current}"?`,
      { modal: true },
      'Unlink'
    );
    if (action !== 'Unlink') {
      return;
    }

    const updated = await updateDeviceHostFolderMapping(deviceId, undefined);
    this.deviceHostFolderMappings = getDeviceHostFolderMappings(updated);

    const msg = `Unlinked ${deviceId} from host folder: ${current}`;
    logChannelOutput(msg, true);
    vscode.window.showInformationMessage(msg);
    await this.refresh(true);
  }

  async setDeviceAlias(node?: MirrorNode): Promise<void> {
    let deviceId = await this.ensureActiveDevice(node);
    if (!deviceId) {
      deviceId = await this.pickKnownDeviceId('Select device to set alias');
      if (deviceId) {
        this.activateDevice(deviceId);
      }
    }
    if (!deviceId) {
      vscode.window.showWarningMessage('Select a device to set an alias.');
      return;
    }

    const existingAlias = this.getDeviceAlias(deviceId) ?? '';
    const input = await vscode.window.showInputBox({
      title: 'Set Device Alias',
      prompt: `Set a friendly alias for ${this.getDeviceDisplayNameWithId(deviceId)}. Leave empty to clear.`,
      value: existingAlias,
      ignoreFocusOut: true,
      validateInput: (value) => {
        const trimmed = value.trim();
        if (trimmed.length > 64) {
          return 'Alias must be 64 characters or fewer.';
        }
        return undefined;
      }
    });
    if (input === undefined) {
      return;
    }

    const alias = input.trim();
    const updated = await updateDeviceAlias(deviceId, alias.length > 0 ? alias : undefined);
    this.deviceAliases = getDeviceAliases(updated);

    const msg = alias.length > 0
      ? `Set alias for ${deviceId}: ${alias}`
      : `Cleared alias for ${deviceId}`;
    logChannelOutput(msg, true);
    vscode.window.showInformationMessage(msg);
    await this.refresh(true);
  }

  async closeDeviceConnection(node?: MirrorNode): Promise<void> {
    const deviceId = this.getNodeDeviceId(node);
    if (!deviceId) {
      vscode.window.showWarningMessage('Select a connected device to disconnect.');
      return;
    }

    await vscode.commands.executeCommand('mekatrol.pyboarddev.disconnectboard', { deviceId });
  }

  async closeAllDeviceConnections(): Promise<void> {
    const connected = this.getConnectedDeviceIds();
    if (connected.length === 0) {
      vscode.window.showInformationMessage('No active board connections to close.');
      return;
    }

    const action = await vscode.window.showWarningMessage(
      `Close all ${connected.length} active board connection(s)?`,
      { modal: true },
      'Close All'
    );
    if (action !== 'Close All') {
      return;
    }

    const closed = await closeAllConnectedBoards(
      false,
      false,
      true,
      true
    );
    if (closed) {
      await this.refresh(false);
      vscode.window.showInformationMessage(`Closed ${connected.length} board connection(s).`);
    }
  }

  setSelectedRemoteNode(node: MirrorNode | undefined): void {
    this.selectedNode = node;
    void this.ensureActiveDevice(node);
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
    await this.ensureActiveDevice(node);
    if (!getConnectedBoard(this.activeDeviceId)) {
      vscode.window.showWarningMessage('Connect to a board before comparing a device file.');
      return;
    }

    if (!this.mirrorRootPath) {
      await this.refresh(false);
    }

    if (!this.mirrorRootPath || node.data.isDirectory || node.data.isRoot || node.data.isIndicator) {
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
    const deviceSegment = encodeURIComponent(this.activeDeviceId ?? '');
    const remoteUri = vscode.Uri.parse(`${remoteDocumentScheme}:/${deviceSegment}/${relativePath}`);
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
    const { deviceId, relativePath } = this.toDeviceAndRelativeRemotePathOrRoot(uri);
    const board = await this.getConnectedBoardOrWait(deviceId);
    const entries = await listDeviceEntries(board);
    const entry = entries.find((item) => item.relativePath === relativePath);
    if (!entry) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }

    const key = uri.toString();
    const previous = this.statCache.get(key);
    const next: vscode.FileStat = {
      type: entry.isDirectory ? vscode.FileType.Directory : vscode.FileType.File,
      ctime: previous?.ctime ?? 0,
      mtime: previous?.mtime ?? Date.now(),
      size: entry.size ?? previous?.size ?? 0
    };
    this.statCache.set(key, next);
    return next;
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const { deviceId, relativePath } = this.toDeviceAndRelativeRemotePathOrRoot(uri);
    if (!deviceId) {
      const roots = getConnectedBoards().map((item) => [encodeURIComponent(item.deviceId), vscode.FileType.Directory] as [string, vscode.FileType]);
      return roots.sort((a, b) => a[0].localeCompare(b[0]));
    }

    const board = await this.getConnectedBoardOrWait(deviceId);
    const parentPath = relativePath;
    const entries = await listDeviceEntries(board);

    const children: [string, vscode.FileType][] = [];
    for (const entry of entries) {
      if (entry.relativePath.length === 0 || entry.relativePath === parentPath) {
        continue;
      }

      const parent = path.posix.dirname(entry.relativePath);
      const directParent = parent === '.' ? '' : toRelativePath(parent);
      if (directParent !== parentPath) {
        continue;
      }

      children.push([
        path.posix.basename(entry.relativePath),
        entry.isDirectory ? vscode.FileType.Directory : vscode.FileType.File
      ]);
    }

    return children.sort((a, b) => a[0].localeCompare(b[0]));
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    const { deviceId, relativePath } = this.toDeviceAndRelativeRemotePathOrRoot(uri);
    const board = await this.getConnectedBoardOrWait(deviceId);
    if (!relativePath) {
      return;
    }

    await createDeviceDirectory(board, relativePath);
    const createdUri = this.toRemoteUri(deviceId ?? '', relativePath);
    this.statCache.delete(createdUri.toString());
    this.onDidChangeFileEmitter.fire([{ type: vscode.FileChangeType.Created, uri: createdUri }]);
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const fallbackFilePath = this.describeRemotePath(uri);
    const { deviceId } = this.toDeviceAndRelativeRemotePathOrRoot(uri);
    let board: NonNullable<ReturnType<typeof getConnectedBoard>>;
    try {
      board = await this.getConnectedBoardOrWait(deviceId);
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
        if (!this.shouldSuppressMissingPathWarning(relativePath)) {
          const friendlyMessage = `the file no longer exists on the device. File: ${relativePath}. ${this.getDeviceDetails(board)}`;
          vscode.window.showWarningMessage(friendlyMessage);
          logChannelOutput(`Remote file not opened. ${friendlyMessage}`, true);
          await this.closeRemoteTabsForUriWithRetry(uri);
        }
        throw vscode.FileSystemError.FileNotFound(uri);
      }
      const readFailureMessage = `failed to open remote file. File: ${relativePath}. ${this.getDeviceDetails(board)}. ${message}`;
      logChannelOutput(`Remote file not opened. ${readFailureMessage}`, true);
      await this.closeRemoteTabsForUriWithRetry(uri);
      throw vscode.FileSystemError.Unavailable(`Failed to read remote file: ${relativePath}. ${message}`);
    }
  }

  async writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    options: { readonly create: boolean; readonly overwrite: boolean }
  ): Promise<void> {
    const { deviceId } = this.toDeviceAndRelativeRemotePathOrRoot(uri);
    const board = await this.getConnectedBoardOrWait(deviceId);
    const relativePath = this.toRelativeRemotePath(uri, board);
    const entries = await listDeviceEntries(board);
    const existing = entries.find((entry) => entry.relativePath === relativePath);
    if (!existing && !options.create) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    if (existing && options.create && !options.overwrite) {
      throw vscode.FileSystemError.FileExists(uri);
    }

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

  async delete(uri: vscode.Uri, options: { readonly recursive: boolean }): Promise<void> {
    const { deviceId } = this.toDeviceAndRelativeRemotePathOrRoot(uri);
    const board = await this.getConnectedBoardOrWait(deviceId);
    const relativePath = this.toRelativeRemotePathOrRoot(uri, board);
    if (!relativePath) {
      throw vscode.FileSystemError.NoPermissions('Deleting the device root is not allowed.');
    }

    if (!options.recursive) {
      const entries = await listDeviceEntries(board);
      const hasChildren = entries.some((entry) => entry.relativePath.startsWith(`${relativePath}/`));
      if (hasChildren) {
        throw vscode.FileSystemError.NoPermissions('Folder is not empty. Use recursive delete.');
      }
    }

    await deleteDevicePath(board, relativePath);
    await this.notifyRemotePathDeleted(relativePath, true);
    this.onDidChangeFileEmitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
  }

  async rename(
    oldUri: vscode.Uri,
    newUri: vscode.Uri,
    options: { readonly overwrite: boolean }
  ): Promise<void> {
    const { deviceId } = this.toDeviceAndRelativeRemotePathOrRoot(oldUri);
    const board = await this.getConnectedBoardOrWait(deviceId);
    const sourcePath = this.toRelativeRemotePath(oldUri, board);
    const targetPath = this.toRelativeRemotePath(newUri, board);
    const entries = await listDeviceEntries(board);
    const targetExists = entries.some((entry) => entry.relativePath === targetPath);
    if (targetExists && !options.overwrite) {
      throw vscode.FileSystemError.FileExists(newUri);
    }

    if (targetExists && options.overwrite) {
      await deleteDevicePath(board, targetPath);
      await this.notifyRemotePathDeleted(targetPath, true);
    }

    await renameDevicePath(board, sourcePath, targetPath);
    await this.notifyRemotePathDeleted(sourcePath, true);
    await this.notifyRemoteFilesChanged([targetPath]);
    this.onDidChangeFileEmitter.fire([
      { type: vscode.FileChangeType.Deleted, uri: oldUri },
      { type: vscode.FileChangeType.Created, uri: newUri }
    ]);
  }

  async notifyRemoteFilesChanged(relativePaths: string[], deviceId?: string): Promise<void> {
    if (relativePaths.length === 0) {
      return;
    }

    const uniqueRelativePaths = [...new Set(relativePaths.map((item) => toRelativePath(item)).filter((item) => item.length > 0))];
    if (uniqueRelativePaths.length === 0) {
      return;
    }

    const events: vscode.FileChangeEvent[] = [];
    const targetDeviceId = deviceId ?? getConnectedBoards()[0]?.deviceId ?? '';
    for (const relativePath of uniqueRelativePaths) {
      const uri = this.toRemoteUri(targetDeviceId, relativePath);
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

    if (segments[0].endsWith(':') && segments.length > 1) {
      segments.shift();
    }

    const connectedIds = new Set(getConnectedBoards().map((item) => item.deviceId));
    const decodedFirst = this.decodeRemoteDeviceSegment(segments[0]);
    if (decodedFirst && connectedIds.has(decodedFirst) && segments.length > 1) {
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

  private toRelativeRemotePathOrRoot(uri: vscode.Uri, board: NonNullable<ReturnType<typeof getConnectedBoard>>): string {
    const rawPath = toRelativePath(uri.path.replace(/^\/+/, ''));
    if (!rawPath) {
      return '';
    }

    const segments = rawPath
      .split('/')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    if (segments.length === 0) {
      return '';
    }

    if (segments[0].endsWith(':') && segments.length > 1) {
      segments.shift();
    }

    const connectedIds = new Set(getConnectedBoards().map((item) => item.deviceId));
    const decodedFirst = this.decodeRemoteDeviceSegment(segments[0]);
    if (decodedFirst && connectedIds.has(decodedFirst) && segments.length > 1) {
      segments.shift();
    }

    const deviceName = (path.basename(board.device) || board.device).replace(/[^\w.-]/g, '_');
    if (segments[0] === deviceName && segments.length > 1) {
      segments.shift();
    }

    return toRelativePath(segments.join('/'));
  }

  private toRemoteUri(deviceId: string, relativePath: string): vscode.Uri {
    const deviceSegment = encodeURIComponent(deviceId);
    const normalised = toRelativePath(relativePath).replace(/^\/+/, '');
    return vscode.Uri.parse(`${remoteDocumentScheme}:/${deviceSegment}/${normalised}`);
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

  private async getConnectedBoardOrWait(deviceId?: string): Promise<NonNullable<ReturnType<typeof getConnectedBoard>>> {
    const connected = getConnectedBoard(deviceId);
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
        const board = getConnectedBoard(deviceId);
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
    const activeBoard = board ?? getConnectedBoard();
    const device = activeBoard?.device ?? 'unknown device';
    const baudRate = activeBoard?.baudrate ?? defaultBaudRate;
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

  private decodeRemoteDeviceSegment(segment: string): string {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  }

  private toDeviceAndRelativeRemotePathOrRoot(uri: vscode.Uri): { deviceId: string | undefined; relativePath: string } {
    const rawPath = toRelativePath(uri.path.replace(/^\/+/, ''));
    if (!rawPath) {
      return { deviceId: undefined, relativePath: '' };
    }

    const segments = rawPath.split('/').map((item) => item.trim()).filter((item) => item.length > 0);
    if (segments.length === 0) {
      return { deviceId: undefined, relativePath: '' };
    }

    const decodedDeviceId = this.decodeRemoteDeviceSegment(segments[0]);
    const hasDevicePrefix = getConnectedBoards().some((item) => item.deviceId === decodedDeviceId) || segments.length > 1;
    if (!hasDevicePrefix) {
      return { deviceId: undefined, relativePath: rawPath };
    }

    return {
      deviceId: decodedDeviceId,
      relativePath: toRelativePath(segments.slice(1).join('/'))
    };
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

  private shouldSuppressMissingPathWarning(relativePath: string): boolean {
    // VS Code and other extensions can probe for workspace metadata files on every workspace folder.
    // Those files generally won't exist on a microcontroller filesystem and should not surface warnings.
    return relativePath.startsWith('.vscode/');
  }
}

class MirrorTreeProvider implements vscode.TreeDataProvider<MirrorNode>, vscode.Disposable {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<MirrorNode | undefined>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private readonly modelDisposable: vscode.Disposable;

  constructor(private readonly model: DeviceMirrorModel) {
    this.modelDisposable = model.onDidChangeData(() => this.onDidChangeTreeDataEmitter.fire(undefined));
  }

  dispose(): void {
    this.modelDisposable.dispose();
    this.onDidChangeTreeDataEmitter.dispose();
  }

  getTreeItem(element: MirrorNode): vscode.TreeItem {
    const data = element.data;
    element.tooltip = undefined;

    if (data.isRoot) {
      element.contextValue = data.side === 'local' ? 'pyboarddev.hostRoot' : 'pyboarddev.deviceRoot';
      element.iconPath = data.side === 'local' ? new vscode.ThemeIcon('desktop-download') : new vscode.ThemeIcon('device-mobile');
      if (data.side === 'device') {
        const count = this.model.getConnectedDeviceIds().length;
        element.description = count > 0 ? `${count} connected` : 'disconnected';
      } else {
        const linkedCount = this.model.getLinkedHostFolderCount();
        element.description = linkedCount > 0
          ? `${linkedCount} linked`
          : `${this.model.getAvailableHostFolderCount()} host folders`;
      }
      element.command = undefined;
      return element;
    }

    if (data.isIndicator) {
      element.contextValue = 'pyboarddev.deviceIndicator';
      element.iconPath = new vscode.ThemeIcon('warning');
      element.command = undefined;
      return element;
    }

    if (data.isDeviceIdNode) {
      const mappedFolder = data.deviceId ? this.model.getMappedHostFolder(data.deviceId) : undefined;
      if (data.side === 'device') {
        element.contextValue = mappedFolder ? 'pyboarddev.deviceIdNodeLinked' : 'pyboarddev.deviceIdNode';
      } else {
        element.contextValue = 'pyboarddev.hostDeviceMappingNode';
      }
      element.iconPath = new vscode.ThemeIcon('device-mobile');
      if (data.deviceId) {
        const alias = this.model.getDeviceAlias(data.deviceId);
        if (alias) {
          element.tooltip = `${alias}\n${data.deviceId}`;
        }
        if (data.side === 'device') {
          const connected = this.model.getConnectedDevice(data.deviceId);
          const state = connected ? 'connected' : 'disconnected';
          element.description = mappedFolder ? `${state} | host:${mappedFolder}` : state;
        } else {
          element.description = mappedFolder ?? 'not linked';
        }
      } else {
        element.description = data.side === 'device' ? 'connected' : 'mirror';
      }
      element.command = undefined;
      return element;
    }

    const isExcludedFromSync = this.model.isNodePathExcludedFromSync(data);
    if (data.side === 'device') {
      if (data.isDirectory) {
        element.contextValue = isExcludedFromSync ? 'pyboarddev.deviceFolderExcluded' : 'pyboarddev.deviceFolder';
      } else {
        element.contextValue = isExcludedFromSync ? 'pyboarddev.deviceFileExcluded' : 'pyboarddev.deviceFile';
      }
      element.command = data.isDirectory ? undefined : { command: commandOpenRemoteFileId, title: 'Open', arguments: [element] };
    } else {
      if (data.isDirectory) {
        element.contextValue = isExcludedFromSync ? 'pyboarddev.hostFolderExcluded' : 'pyboarddev.hostFolder';
      } else {
        element.contextValue = isExcludedFromSync ? 'pyboarddev.hostFileExcluded' : 'pyboarddev.hostFile';
      }
      element.command = data.isDirectory ? undefined : { command: commandOpenLocalItemId, title: 'Open', arguments: [element] };
    }
    element.iconPath = data.isDirectory ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;
    element.description = isExcludedFromSync ? 'excluded' : undefined;

    return element;
  }

  getChildren(element?: MirrorNode): MirrorNode[] {
    if (!element) {
      return [
        new MirrorNode(
          {
            side: 'local',
            relativePath: '',
            isDirectory: true,
            isRoot: true
          },
          'HOST',
          vscode.TreeItemCollapsibleState.Expanded
        ),
        new MirrorNode(
          {
            side: 'device',
            relativePath: '',
            isDirectory: true,
            isRoot: true
          },
          'DEVICE',
          vscode.TreeItemCollapsibleState.Expanded
        )
      ];
    }

    if (element.data.isIndicator || !element.data.isDirectory) {
      return [];
    }

    if (element.data.isRoot) {
      if (element.data.side === 'local') {
        const linkedHostDeviceIds = this.model.getLinkedHostDeviceIds();
        if (linkedHostDeviceIds.length > 0) {
          const linkedByFolder = new Map<string, string>();
          for (const deviceId of linkedHostDeviceIds) {
            const mappedFolder = this.model.getMappedHostFolder(deviceId);
            const folderKey = mappedFolder && mappedFolder.trim().length > 0
              ? toRelativePath(mappedFolder)
              : `__device__/${deviceId}`;
            if (!linkedByFolder.has(folderKey)) {
              linkedByFolder.set(folderKey, deviceId);
            }
          }

          return [...linkedByFolder.entries()]
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([folderKey, deviceId]) => {
              const label = folderKey.startsWith('__device__/')
                ? this.model.getDeviceDisplayName(deviceId)
                : path.posix.basename(folderKey);
              return new MirrorNode(
              {
                side: 'local',
                relativePath: '',
                isDirectory: true,
                deviceId,
                isDeviceIdNode: true
              },
              label,
              vscode.TreeItemCollapsibleState.Collapsed
            );
            });
        }

        const availableHostFolders = this.model.getAvailableHostFolders();
        if (availableHostFolders.length === 0) {
          return [
            new MirrorNode(
              {
                side: 'local',
                relativePath: '',
                isDirectory: false,
                isIndicator: true
              },
              'No host folders',
              vscode.TreeItemCollapsibleState.None
            )
          ];
        }

        return availableHostFolders.map((folderPath) => {
          const label = path.posix.basename(folderPath);
          return new MirrorNode(
            {
              side: 'local',
              relativePath: label,
              isDirectory: true
            },
            label,
            vscode.TreeItemCollapsibleState.Collapsed
          );
        });
      }

      const deviceIds = this.model.getConnectedDeviceIds();
      if (deviceIds.length === 0) {
        return [];
      }

      return deviceIds.map((deviceId) => {
        const connected = this.model.getConnectedDevice(deviceId);
        const alias = this.model.getDeviceAlias(deviceId);
        const label = alias ?? (connected ? this.toDeviceLeafLabel(connected) : deviceId);
        return new MirrorNode(
          {
            side: 'device',
            relativePath: '',
            isDirectory: true,
            deviceId,
            isDeviceIdNode: true
          },
          label,
          vscode.TreeItemCollapsibleState.Collapsed
        );
      });
    }

    return this.model.getNodeChildren(
      element.data.side,
      element.data.isDeviceIdNode ? '' : element.data.relativePath,
      element.data.deviceId
    );
  }

  private toSerialPortName(devicePath: string): string {
    return path.basename(devicePath) || devicePath;
  }

  private toDeviceLeafLabel(
    device: ReturnType<DeviceMirrorModel['getConnectedDevice']> extends infer T ? T : never
  ): string {
    const machine = device?.runtimeInfo?.machine?.trim() || 'Unknown device';
    const port = this.toSerialPortName(device?.devicePath ?? '');
    const deviceId = device?.deviceId ?? 'unknown';
    return `${machine} [${port}: ${deviceId}]`;
  }
}

const hostWorkspaceFolderName = 'HOST';
const deviceWorkspaceFolderName = 'DEVICE';
const mountHostWorkspaceFolderSettingKey = 'mountHostInWorkspaceExplorer';
const mountDeviceWorkspaceFolderSettingKey = 'mountDeviceInWorkspaceExplorer';

const ensureNativeExplorerRoots = async (model: DeviceMirrorModel): Promise<void> => {
  const mirrorRootPath = model.getMirrorRootPath();
  if (!mirrorRootPath) {
    return;
  }

  const hostUri = vscode.Uri.file(mirrorRootPath);
  const deviceUri = vscode.Uri.parse(`${remoteDocumentScheme}:/`);
  const configuration = vscode.workspace.getConfiguration('mekatrol.pyboarddev');
  const mountHostWorkspaceFolder = configuration.get<boolean>(mountHostWorkspaceFolderSettingKey, false);
  const mountDeviceWorkspaceFolder = configuration.get<boolean>(mountDeviceWorkspaceFolderSettingKey, false);
  const existing = vscode.workspace.workspaceFolders ?? [];
  const existingHostIndex = existing.findIndex((folder) => folder.uri.toString() === hostUri.toString());
  const existingDeviceIndex = existing.findIndex((folder) => folder.uri.toString() === deviceUri.toString());

  if (!mountHostWorkspaceFolder && existingHostIndex >= 0) {
    vscode.workspace.updateWorkspaceFolders(existingHostIndex, 1);
  }

  if (!mountDeviceWorkspaceFolder && existingDeviceIndex >= 0) {
    vscode.workspace.updateWorkspaceFolders(existingDeviceIndex, 1);
  }

  const currentFolders = vscode.workspace.workspaceFolders ?? [];
  const hostExists = currentFolders.some((folder) => folder.uri.toString() === hostUri.toString());
  const deviceExists = currentFolders.some((folder) => folder.uri.toString() === deviceUri.toString());

  const additions: { uri: vscode.Uri; name: string }[] = [];
  if (mountHostWorkspaceFolder && !hostExists) {
    additions.push({ uri: hostUri, name: hostWorkspaceFolderName });
  }
  if (mountDeviceWorkspaceFolder && !deviceExists) {
    additions.push({ uri: deviceUri, name: deviceWorkspaceFolderName });
  }

  if (additions.length === 0) {
    return;
  }

  vscode.workspace.updateWorkspaceFolders(currentFolders.length, 0, ...additions);
};

export const initDeviceMirrorExplorer = async (context: vscode.ExtensionContext): Promise<void> => {
  const remoteFsProvider = new RemoteDeviceFileSystemProvider(context);
  const model = new DeviceMirrorModel(context, async (relativePaths: string[]) => {
    await remoteFsProvider.notifyRemoteFilesChanged(relativePaths, model.getActiveDeviceId());
  }, async (relativePath: string, includeDescendants: boolean) => {
    await remoteFsProvider.notifyRemotePathDeleted(relativePath, includeDescendants);
  });

  const provider = new MirrorTreeProvider(model);

  context.subscriptions.push(provider);
  const treeView = vscode.window.createTreeView(mirrorViewId, { treeDataProvider: provider });
  context.subscriptions.push(treeView);
  context.subscriptions.push(vscode.workspace.registerFileSystemProvider(remoteDocumentScheme, remoteFsProvider, { isCaseSensitive: true }));

  context.subscriptions.push(treeView.onDidChangeSelection(async (event) => {
    const node = event.selection[0];
    model.setSelectedRemoteNode(node);
  }));

  context.subscriptions.push(treeView.onDidChangeVisibility((event) => {
    if (!event.visible || !model.isBoardConnected()) {
      return;
    }

    void model.refresh(true);
  }));

  const remoteExplorerAutoRefreshTimer = setInterval(() => {
    if (!treeView.visible || !model.isBoardConnected()) {
      return;
    }

    void model.refresh(true);
  }, remoteExplorerAutoRefreshIntervalMs);
  context.subscriptions.push(new vscode.Disposable(() => clearInterval(remoteExplorerAutoRefreshTimer)));

  context.subscriptions.push(onBoardConnectionStateChanged(() => model.refresh()));
  context.subscriptions.push(onBoardConnectionsChanged(() => model.refresh()));
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
  context.subscriptions.push(vscode.commands.registerCommand(commandSyncNodeFromDeviceId, async (node?: MirrorNode) => model.syncNodeFromDevice(node)));
  context.subscriptions.push(vscode.commands.registerCommand(commandSyncNodeToDeviceId, async (node?: MirrorNode) => model.syncNodeToDevice(node)));
  context.subscriptions.push(vscode.commands.registerCommand(commandOpenLocalItemId, async (node: MirrorNode) => model.openLocalNode(node)));
  context.subscriptions.push(vscode.commands.registerCommand(commandPullAndOpenDeviceItemId, async (node: MirrorNode) => model.pullDeviceNodeAndOpen(node)));
  context.subscriptions.push(vscode.commands.registerCommand(commandOpenRemoteFileId, async (node?: MirrorNode) => model.openRemoteFile(node)));
  context.subscriptions.push(vscode.commands.registerCommand(commandCompareRemoteWithLocalId, async (node?: MirrorNode) => model.compareRemoteWithLocal(node)));
  context.subscriptions.push(vscode.commands.registerCommand(commandCreateMirrorFileId, async (node?: MirrorNode) => model.createMirrorFile(node)));
  context.subscriptions.push(vscode.commands.registerCommand(commandCreateMirrorFolderId, async (node?: MirrorNode) => model.createMirrorFolder(node)));
  context.subscriptions.push(vscode.commands.registerCommand(commandRenameMirrorPathId, async (node?: MirrorNode) => model.renameMirrorPath(node)));
  context.subscriptions.push(vscode.commands.registerCommand(commandDeleteMirrorPathId, async (node?: MirrorNode) => model.deleteMirrorPath(node)));
  context.subscriptions.push(vscode.commands.registerCommand(commandLinkDeviceHostFolderId, async (node?: MirrorNode) => model.linkDeviceToHostFolder(node)));
  context.subscriptions.push(vscode.commands.registerCommand(commandUnlinkDeviceHostFolderId, async (node?: MirrorNode) => model.unlinkDeviceFromHostFolder(node)));
  context.subscriptions.push(vscode.commands.registerCommand(commandSetDeviceAliasId, async (node?: MirrorNode) => model.setDeviceAlias(node)));
  context.subscriptions.push(vscode.commands.registerCommand(commandExcludeDeviceFileFromSyncId, async (node?: MirrorNode) => model.excludeDeviceFileFromSync(node)));
  context.subscriptions.push(vscode.commands.registerCommand(commandRemoveDeviceFileFromSyncExclusionId, async (node?: MirrorNode) => model.removeDeviceFileFromSyncExclusion(node)));
  context.subscriptions.push(vscode.commands.registerCommand(commandCloseDeviceConnectionId, async (node?: MirrorNode) => model.closeDeviceConnection(node)));
  context.subscriptions.push(vscode.commands.registerCommand(commandCloseAllDeviceConnectionsId, async () => model.closeAllDeviceConnections()));
  context.subscriptions.push(vscode.commands.registerCommand(commandConnectBoardWithPickerId, async () => {
    await vscode.commands.executeCommand('mekatrol.pyboarddev.connectboard', { forcePickPort: true });
  }));

  await model.refresh();
  await ensureNativeExplorerRoots(model);
};
