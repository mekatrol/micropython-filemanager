/**
 * Module overview:
 * Implements the PyDevice Explorer tree, sync actions, and virtual
 * filesystem integration for connected devices.
 */
import { Buffer } from 'buffer';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { closeAllConnectedPyDevices, getConnectedPyDevice, getConnectedPyDevices, onBoardConnectionStateChanged, onBoardConnectionsChanged } from './commands/connect-board-command';
import { logChannelOutput } from './output-channel';
import {
  createDefaultConfiguration,
  PyDeviceConfigurationResult,
  configurationFileName,
  getDeviceLibraryFolderMappings,
  getDeviceNames,
  getDeviceHostFolderMappings,
  getDeviceSyncExcludedPaths,
  loadConfiguration,
  updateDeviceLibraryFolders,
  updateDeviceName,
  updateDeviceSyncExcludedPaths,
  updateDeviceHostFolderMapping,
  updateDeviceSyncExclusion
} from './utils/configuration';
import { createDefaultWorkspaceCacheFile, workspaceCacheFileName } from './utils/workspace-cache';
import {
  createDeviceDirectory,
  deleteDevicePath,
  FileEntry,
  SyncState,
  buildSyncStateMap,
  listDeviceEntries,
  readDeviceFile,
  renameDevicePath,
  scanComputerSyncEntries,
  toRelativePath,
  writeDeviceFile
} from './utils/device-filesystem';

const syncViewId = 'mekatrol.pydevice.syncExplorer';
const commandRefreshId = 'mekatrol.pydevice.refreshsyncview';
const commandSyncFromDeviceId = 'mekatrol.pydevice.syncfromdevice';
const commandSyncToDeviceId = 'mekatrol.pydevice.synctodevice';
const commandSyncNodeFromDeviceId = 'mekatrol.pydevice.syncnodefromdevice';
const commandSyncNodeToDeviceId = 'mekatrol.pydevice.syncnodetodevice';
const commandOpenComputerItemId = 'mekatrol.pydevice.opencomputersyncitem';
const commandPullAndOpenDeviceItemId = 'mekatrol.pydevice.pullandopendeviceitem';
const commandOpenDeviceFileId = 'mekatrol.pydevice.opendevicefile';
const commandOpenComputerItemFromTreeId = 'mekatrol.pydevice._opencomputersyncitemfromtree';
const commandOpenDeviceFileFromTreeId = 'mekatrol.pydevice._opendevicefilefromtree';
const commandCompareDeviceWithComputerId = 'mekatrol.pydevice.comparedevicewithcomputer';
const commandCompareDeviceFilesId = 'mekatrol.pydevice.comparedevicefiles';
const commandCreateSyncFileId = 'mekatrol.pydevice.createsyncfile';
const commandCreateSyncFolderId = 'mekatrol.pydevice.createsyncfolder';
const commandRenameSyncPathId = 'mekatrol.pydevice.renamesyncpath';
const commandDeleteSyncPathId = 'mekatrol.pydevice.deletesyncpath';
const commandMapDeviceHostFolderId = 'mekatrol.pydevice.mapdevicehostfolder';
const commandUnmapDeviceHostFolderId = 'mekatrol.pydevice.unmapdevicehostfolder';
const commandAddDeviceLibraryFolderId = 'mekatrol.pydevice.adddevicelibraryfolder';
const commandRemoveDeviceLibraryFolderId = 'mekatrol.pydevice.removedevicelibraryfolder';
const commandSetDeviceNameId = 'mekatrol.pydevice.setdevicename';
const commandExcludeDeviceFileFromSyncId = 'mekatrol.pydevice.excludedevicefilefromsync';
const commandRemoveDeviceFileFromSyncExclusionId = 'mekatrol.pydevice.removedevicefilefromsyncexclusion';
const commandCloseDeviceConnectionId = 'mekatrol.pydevice.closedeviceconnection';
const commandCloseAllDeviceConnectionsId = 'mekatrol.pydevice.closealldeviceconnections';
const commandConnectBoardWithPickerId = 'mekatrol.pydevice.connectboardwithpicker';
const commandExplorerPrerequisitesHintId = 'mekatrol.pydevice.explorerprerequisiteshint';
const commandExplorerInitialiseWorkspaceId = 'mekatrol.pydevice.explorerinitialiseworkspace';
const deviceDocumentScheme = 'pydevice-device';
const defaultBaudRate = 115200;
const deviceExplorerAutoRefreshIntervalMs = 5000;
const deviceCreateConfirmTimeoutMs = 6000;
const deviceCreateConfirmPollIntervalMs = 150;
const hasHostSyncChildFoldersContextKey = 'mekatrol.pydevice.hasHostSyncChildFolders';
const hasMappedHostMappingsContextKey = 'mekatrol.pydevice.hasMappedHostMappings';
const explorerHasWorkspaceContextKey = 'mekatrol.pydevice.explorerHasWorkspace';
const explorerHasConfigurationContextKey = 'mekatrol.pydevice.explorerHasConfiguration';
const explorerHasSyncFolderContextKey = 'mekatrol.pydevice.explorerHasSyncFolder';
const explorerReadyContextKey = 'mekatrol.pydevice.explorerReady';
const nameHistoryStateKey = 'mekatrol.pydevice.nameHistoryByLower';

type NodeSide = 'device' | 'computer';

interface NodeData {
  side: NodeSide;
  relativePath: string;
  isDirectory: boolean;
  deviceId?: string;
  libraryHostFolder?: string;
  libraryDeviceRoot?: string;
  isLibraryNode?: boolean;
  isLibraryMissing?: boolean;
  isDeviceIdNode?: boolean;
  isRoot?: boolean;
  isIndicator?: boolean;
}

type DeviceFileCompareAvailability = 'available' | 'unmapped' | 'hostMissing';

interface DeviceLibraryMapping {
  hostRelativePath: string;
  hostAbsolutePath: string;
  devicePath: string;
  missing: boolean;
}

type SyncAction = 'create' | 'modify' | 'delete';

interface SyncOperation {
  id: string;
  action: SyncAction;
  relativePath: string;
  isDirectory: boolean;
  excluded: boolean;
  defaultChecked?: boolean;
  deviceRelativePath?: string;
  computerRootPath?: string;
  computerRelativePath?: string;
}

type SyncOperationRunStatus = 'pending' | 'in_progress' | 'success' | 'skipped' | 'error';

interface SyncOperationsDialog {
  selectedIds: Set<string>;
  setStatus: (operationId: string, status: SyncOperationRunStatus, errorText?: string) => void;
  finish: (summary: string) => Promise<void>;
}

interface OpenEditorOptions {
  explorerClick?: boolean;
}

type DeviceFileCompareStatus = 'match' | 'mismatch' | 'missing_computer' | 'missing_device';

interface DeviceFileCompareRow {
  id: string;
  deviceRelativePath: string;
  status: DeviceFileCompareStatus;
  libraryHostFolder?: string;
  libraryDeviceRoot?: string;
  scopeLabel: string;
  scopeIcon: 'library' | 'folder';
}

class SyncNode extends vscode.TreeItem {
  public readonly data: NodeData;

  constructor(data: NodeData, label: string, collapsibleState: vscode.TreeItemCollapsibleState) {
    super(label, collapsibleState);
    this.data = data;
    const marker = data.isRoot
      ? 'root'
      : (data.isDeviceIdNode ? 'deviceId' : (data.isIndicator ? 'indicator' : (data.isLibraryNode ? 'library' : 'entry')));
    const deviceKey = data.deviceId ?? '';
    const pathKey = toRelativePath(data.relativePath);
    const typeKey = data.isDirectory ? 'dir' : 'file';
    this.id = `${data.side}:${marker}:${deviceKey}:${pathKey}:${typeKey}`;
  }
}

class DeviceSyncModel {
  private readonly onDidChangeDataEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeData = this.onDidChangeDataEmitter.event;

  private workspaceFolder: vscode.WorkspaceFolder | undefined;
  private syncRootPath: string | undefined;
  private deviceHostFolderMappings: Record<string, string> = {};
  private deviceLibraryFolderMappings: Record<string, string[]> = {};
  private deviceNames: Record<string, string> = {};
  private deviceSyncExcludedPaths: Record<string, Set<string>> = {};
  private knownDeviceIds: Set<string> = new Set();
  private activeDeviceId: string | undefined;
  private syncRootByDeviceId = new Map<string, string>();
  private computerEntriesByDeviceId = new Map<string, FileEntry[]>();
  private deviceEntriesByDeviceId = new Map<string, FileEntry[]>();
  private syncStatesByDeviceId = new Map<string, Map<string, SyncState>>();
  private librariesByDeviceId = new Map<string, DeviceLibraryMapping[]>();
  private mappableHostFolders: string[] = [];
  private unmappedHostEntries: FileEntry[] = [{ relativePath: '', isDirectory: true }];

  private computerEntries: FileEntry[] = [{ relativePath: '', isDirectory: true }];
  private deviceEntries: FileEntry[] = [{ relativePath: '', isDirectory: true }];
  private syncStates: Map<string, SyncState> = new Map();
  private selectedNode: SyncNode | undefined;
  private lastExplorerOpenUri: string | undefined;
  private lastExplorerOpenAtMs = 0;
  private duplicateNameWarningKey: string | undefined;
  private openTabNameSyncKey: string | undefined;
  private nameHistoryByLower: Record<string, string>;
  private lastRefreshError: string | undefined;
  private hasWarnedNoWorkspaceFolder = false;
  private hasWarnedMissingConfiguration = false;
  private explorerReady = false;
  private hasConfigurationFile = false;
  private hasSyncFolder = true;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly notifyDeviceFilesChanged?: (relativePaths: string[]) => Promise<void>,
    private readonly notifyDevicePathDeleted?: (relativePath: string, includeDescendants: boolean) => Promise<void>,
    private readonly revealPathNode?: (target: { side: NodeSide; relativePath: string; deviceId?: string }) => Promise<void>
  ) {
    this.nameHistoryByLower = this.context.globalState.get<Record<string, string>>(nameHistoryStateKey, {});
  }

  private async revealNode(target: { side: NodeSide; relativePath: string; deviceId?: string }): Promise<void> {
    if (!this.revealPathNode) {
      return;
    }
    await this.revealPathNode(target);
  }

  private async wait(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async waitForDeviceEntry(
    board: NonNullable<ReturnType<typeof getConnectedPyDevice>>,
    relativePath: string,
    isDirectory: boolean
  ): Promise<boolean> {
    const targetPath = toRelativePath(relativePath);
    const deadline = Date.now() + deviceCreateConfirmTimeoutMs;

    while (Date.now() <= deadline) {
      try {
        const entries = await listDeviceEntries(board);
        const found = entries.some((entry) => toRelativePath(entry.relativePath) === targetPath && entry.isDirectory === isDirectory);
        if (found) {
          return true;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logChannelOutput(`Waiting for device path "/${targetPath}" failed: ${message}`, false);
      }

      await this.wait(deviceCreateConfirmPollIntervalMs);
    }

    return false;
  }

  async refresh(fetchDevice: boolean = true): Promise<void> {
    try {
    this.workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const hasWorkspace = !!this.workspaceFolder;
    let hasConfiguration = false;
    const hasSyncFolder = hasWorkspace;
    if (hasWorkspace && this.workspaceFolder) {
      const configUri = this.workspaceFolder.uri.with({
        path: path.posix.join(this.workspaceFolder.uri.path, configurationFileName)
      });
      try {
        await vscode.workspace.fs.stat(configUri);
        hasConfiguration = true;
      } catch {
        hasConfiguration = false;
      }
    }
    this.hasConfigurationFile = hasConfiguration;
    this.hasSyncFolder = hasSyncFolder;
    this.explorerReady = hasWorkspace && hasConfiguration && hasSyncFolder;
    await vscode.commands.executeCommand('setContext', explorerHasWorkspaceContextKey, hasWorkspace);
    await vscode.commands.executeCommand('setContext', explorerHasConfigurationContextKey, hasConfiguration);
    await vscode.commands.executeCommand('setContext', explorerHasSyncFolderContextKey, hasSyncFolder);
    await vscode.commands.executeCommand('setContext', explorerReadyContextKey, this.explorerReady);

    if (!hasWorkspace) {
      if (!this.hasWarnedNoWorkspaceFolder) {
        const message = 'Open a workspace folder to show devices in PyDevice Explorer.';
        this.hasWarnedNoWorkspaceFolder = true;
        vscode.window.showWarningMessage(message);
        logChannelOutput(message, true);
      }
      this.computerEntries = [{ relativePath: '', isDirectory: true }];
      this.deviceEntries = [{ relativePath: '', isDirectory: true }];
      this.syncStates = new Map();
      this.mappableHostFolders = [];
      this.deviceLibraryFolderMappings = {};
      this.librariesByDeviceId.clear();
      this.deviceSyncExcludedPaths = {};
      await vscode.commands.executeCommand('setContext', hasHostSyncChildFoldersContextKey, false);
      await vscode.commands.executeCommand('setContext', hasMappedHostMappingsContextKey, false);
      this.onDidChangeDataEmitter.fire();
      return;
    }
    this.hasWarnedNoWorkspaceFolder = false;
    if (!hasConfiguration) {
      this.hasWarnedMissingConfiguration = true;
      this.computerEntries = [{ relativePath: '', isDirectory: true }];
      this.deviceEntries = [{ relativePath: '', isDirectory: true }];
      this.syncStates = new Map();
      this.mappableHostFolders = [];
      this.deviceLibraryFolderMappings = {};
      this.librariesByDeviceId.clear();
      this.deviceSyncExcludedPaths = {};
      await vscode.commands.executeCommand('setContext', hasHostSyncChildFoldersContextKey, false);
      await vscode.commands.executeCommand('setContext', hasMappedHostMappingsContextKey, false);
      this.onDidChangeDataEmitter.fire();
      return;
    }
    this.hasWarnedMissingConfiguration = false;
    const config = await loadConfiguration();
    this.deviceHostFolderMappings = getDeviceHostFolderMappings(config);
    this.deviceLibraryFolderMappings = getDeviceLibraryFolderMappings(config);
    this.deviceNames = getDeviceNames(config);
    await this.syncNameHistory();
    this.validateNameConfigurationAndWarn();
    const nameSyncKey = this.computeNameSyncKey();
    if (this.openTabNameSyncKey !== nameSyncKey) {
      await this.normalizeOpenDeviceTabsToCurrentNameSegments();
      this.openTabNameSyncKey = nameSyncKey;
    }
    this.deviceSyncExcludedPaths = Object.fromEntries(
      Object.entries(getDeviceSyncExcludedPaths(config)).map(([deviceId, relativePaths]) => [deviceId, new Set(relativePaths)])
    );
    this.mappableHostFolders = await this.getMappableHostFolders();
    await vscode.commands.executeCommand('setContext', hasHostSyncChildFoldersContextKey, this.mappableHostFolders.length > 0);
    await vscode.commands.executeCommand('setContext', hasMappedHostMappingsContextKey, Object.keys(this.deviceHostFolderMappings).length > 0);
    this.knownDeviceIds = new Set([
      ...Object.keys(this.deviceHostFolderMappings),
      ...Object.keys(this.deviceLibraryFolderMappings),
      ...Object.keys(this.deviceNames)
    ]);

    const connected = getConnectedPyDevices();
    connected.forEach((item) => this.knownDeviceIds.add(item.deviceId));

    for (const deviceId of this.knownDeviceIds) {
      const libraryMappings = await this.resolveDeviceLibraryMappings(deviceId);
      this.librariesByDeviceId.set(deviceId, libraryMappings);
      const syncRootPath = this.toDeviceSyncPath(deviceId);
      if (syncRootPath) {
        this.syncRootByDeviceId.set(deviceId, syncRootPath);
      } else {
        this.syncRootByDeviceId.delete(deviceId);
      }
      const computerEntries = syncRootPath
        ? await scanComputerSyncEntries(syncRootPath)
        : [{ relativePath: '', isDirectory: true }];
      this.computerEntriesByDeviceId.set(deviceId, computerEntries);

      let deviceEntries: FileEntry[] = [{ relativePath: '', isDirectory: true }];
      if (fetchDevice) {
        const board = getConnectedPyDevice(deviceId);
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
      this.syncStatesByDeviceId.set(
        deviceId,
        buildSyncStateMap(this.filterSyncableEntries(computerEntries), this.filterSyncableEntries(deviceEntries))
      );
    }

    if (!this.activeDeviceId || !this.knownDeviceIds.has(this.activeDeviceId)) {
      this.activeDeviceId = connected[0]?.deviceId ?? [...this.knownDeviceIds][0];
    }
    this.activateDevice(this.activeDeviceId);
    const hostRootPath = this.getHostSyncRootPath();
    this.unmappedHostEntries = hostRootPath
      ? await scanComputerSyncEntries(hostRootPath)
      : [{ relativePath: '', isDirectory: true }];
    this.lastRefreshError = undefined;
    this.onDidChangeDataEmitter.fire();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logChannelOutput(`Sync refresh failed: ${message}`, true);
      if (this.lastRefreshError !== message) {
        this.lastRefreshError = message;
        vscode.window.showErrorMessage(`PyDevice Explorer refresh failed: ${message}`);
      }
    }
  }

  private getHostSyncRootPath(): string | undefined {
    if (!this.workspaceFolder) {
      return undefined;
    }

    return this.workspaceFolder.uri.fsPath;
  }

  private async getMappableHostFolders(): Promise<string[]> {
    const syncRootPath = this.getHostSyncRootPath();
    if (!syncRootPath) {
      return [];
    }
    try {
      const children = await fs.readdir(syncRootPath, { withFileTypes: true });
      return children
        .filter((child) => child.isDirectory())
        .map((child) => toRelativePath(child.name))
        .sort((a, b) => a.localeCompare(b));
    } catch {
      return [];
    }
  }

  private toDeviceSyncPath(deviceId: string): string | undefined {
    if (!this.workspaceFolder) {
      return undefined;
    }

    const mapped = this.deviceHostFolderMappings[deviceId];
    if (mapped && mapped.trim().length > 0) {
      return path.join(this.workspaceFolder.uri.fsPath, mapped);
    }
    return undefined;
  }

  private resolveWorkspaceRelativePath(relativePath: string): string | undefined {
    if (!this.workspaceFolder) {
      return undefined;
    }
    return path.resolve(this.workspaceFolder.uri.fsPath, relativePath);
  }

  private async resolveDeviceLibraryMappings(deviceId: string): Promise<DeviceLibraryMapping[]> {
    const configured = this.deviceLibraryFolderMappings[deviceId] ?? [];
    const mappings: DeviceLibraryMapping[] = [];
    for (const configuredFolder of configured) {
      const hostRelativePath = toRelativePath(configuredFolder);
      if (!hostRelativePath) {
        continue;
      }
      const hostAbsolutePath = this.resolveWorkspaceRelativePath(hostRelativePath);
      if (!hostAbsolutePath) {
        continue;
      }
      const devicePath = toRelativePath(path.posix.basename(hostRelativePath));
      if (!devicePath) {
        continue;
      }

      let missing = false;
      try {
        const stat = await fs.stat(hostAbsolutePath);
        missing = !stat.isDirectory();
      } catch {
        missing = true;
      }

      mappings.push({ hostRelativePath, hostAbsolutePath, devicePath, missing });
    }

    const uniqueByHost = new Map<string, DeviceLibraryMapping>();
    for (const mapping of mappings) {
      uniqueByHost.set(mapping.hostRelativePath, mapping);
    }
    return [...uniqueByHost.values()].sort((a, b) => a.devicePath.localeCompare(b.devicePath));
  }

  private activateDevice(deviceId: string | undefined): void {
    this.activeDeviceId = deviceId;
    if (!deviceId) {
      this.computerEntries = [{ relativePath: '', isDirectory: true }];
      this.deviceEntries = [{ relativePath: '', isDirectory: true }];
      this.syncStates = new Map();
      this.syncRootPath = undefined;
      return;
    }

    this.computerEntries = this.computerEntriesByDeviceId.get(deviceId) ?? [{ relativePath: '', isDirectory: true }];
    this.deviceEntries = this.deviceEntriesByDeviceId.get(deviceId) ?? [{ relativePath: '', isDirectory: true }];
    this.syncStates = this.syncStatesByDeviceId.get(deviceId) ?? new Map();
    this.syncRootPath = this.syncRootByDeviceId.get(deviceId);
  }

  private getNodeDeviceId(node?: SyncNode): string | undefined {
    if (node?.data.deviceId) {
      return node.data.deviceId;
    }

    if (this.selectedNode?.data.deviceId) {
      return this.selectedNode.data.deviceId;
    }

    return this.activeDeviceId ?? getConnectedPyDevices()[0]?.deviceId;
  }

  private async ensureActiveDevice(node?: SyncNode): Promise<string | undefined> {
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
        const name = this.getDeviceName(deviceId);
        const mapping = this.getMappedHostFolder(deviceId) ?? 'not mapped';
        return {
          deviceId,
          label: name ?? deviceId,
          description: name ? `${deviceId} | ${mapping}` : mapping
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
    if (!this.workspaceFolder || !this.syncRootPath) {
      await this.refresh(false);
    }

    const board = getConnectedPyDevice(this.activeDeviceId);
    if (!board) {
      vscode.window.showWarningMessage('Connect to a board before syncing from device.');
      return;
    }

    if (!this.syncRootPath) {
      vscode.window.showWarningMessage('Map this device to a computer folder before syncing from device.');
      return;
    }

    const deviceEntries = await listDeviceEntries(board);
    if (this.activeDeviceId) {
      await this.pruneMissingDeviceSyncExclusions(this.activeDeviceId, deviceEntries);
    }
    const computerEntries = await scanComputerSyncEntries(this.syncRootPath);
    const syncableDeviceEntries = this.filterSyncableEntries(deviceEntries);
    const syncableComputerEntries = this.filterSyncableEntries(computerEntries);
    const deviceEntryMap = new Map(syncableDeviceEntries.map((entry) => [toRelativePath(entry.relativePath), entry]));
    const computerEntryMap = new Map(syncableComputerEntries.map((entry) => [toRelativePath(entry.relativePath), entry]));
    const protectedComputerPaths = this.getProtectedSyncPaths(syncableComputerEntries, this.activeDeviceId);
    const desiredDevicePaths = new Set(syncableDeviceEntries.map((entry) => toRelativePath(entry.relativePath)));
    const syncOperations: SyncOperation[] = [];

    for (const entry of syncableDeviceEntries) {
      const relativePath = toRelativePath(entry.relativePath);
      if (!relativePath) {
        continue;
      }
      const isExcluded = this.isPathExcludedFromSync(relativePath, this.activeDeviceId);

      const computerEntry = computerEntryMap.get(relativePath);
      if (!computerEntry) {
        const operation: Omit<SyncOperation, 'id'> = {
          action: 'create',
          relativePath,
          isDirectory: entry.isDirectory,
          excluded: isExcluded
        };
        syncOperations.push({ ...operation, id: this.toSyncOperationId(operation) });
        continue;
      }

      if (computerEntry.isDirectory !== entry.isDirectory) {
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

      const needsWrite = !entry.sha1 || !computerEntry.sha1 || entry.sha1 !== computerEntry.sha1;
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

    for (const entry of syncableComputerEntries) {
      const relativePath = toRelativePath(entry.relativePath);
      if (!relativePath) {
        continue;
      }
      if (desiredDevicePaths.has(relativePath)) {
        continue;
      }
      if (protectedComputerPaths.has(relativePath)) {
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

    const syncDialog = await this.pickSyncOperations(
      'Sync Preview',
      'DEVICE => COMPUTER',
      syncOperations
    );
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
        await fs.rm(path.join(this.syncRootPath, operation.relativePath), { recursive: true, force: true });
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
        const computerPath = path.join(this.syncRootPath, operation.relativePath);
        try {
          const stat = await fs.stat(computerPath);
          if (!stat.isDirectory()) {
            await fs.rm(computerPath, { recursive: true, force: true });
          }
        } catch {
          // Path does not exist; create below.
        }
        await fs.mkdir(computerPath, { recursive: true });
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
        const computerPath = path.join(this.syncRootPath, operation.relativePath);
        try {
          const stat = await fs.stat(computerPath);
          if (stat.isDirectory()) {
            await fs.rm(computerPath, { recursive: true, force: true });
          }
        } catch {
          // Path does not exist; create parent below.
        }
        await fs.mkdir(path.dirname(computerPath), { recursive: true });
        const content = await readDeviceFile(board, operation.relativePath);
        await fs.writeFile(computerPath, content);
        updatedDeviceFiles.push(operation.relativePath);
        syncDialog.setStatus(operation.id, 'success');
      } catch (error) {
        failedCount += 1;
        syncDialog.setStatus(operation.id, 'error', this.toErrorMessage(error));
      }
    }

    this.deviceEntries = deviceEntries;
    this.computerEntries = await scanComputerSyncEntries(this.syncRootPath);
    this.syncStates = buildSyncStateMap(this.filterSyncableEntries(this.computerEntries), this.filterSyncableEntries(this.deviceEntries));
    this.onDidChangeDataEmitter.fire();
    if (this.notifyDeviceFilesChanged) {
      await this.notifyDeviceFilesChanged(updatedDeviceFiles);
    }

    const msg = failedCount > 0
      ? `Sync from device finished with ${failedCount} error(s).`
      : 'Sync from device complete.';
    await syncDialog.finish(msg);
    vscode.window.showInformationMessage(msg);
    logChannelOutput(msg, true);
  }

  private isWithinLibraryRoots(relativePath: string, libraryRoots: Set<string>): boolean {
    for (const root of libraryRoots) {
      if (relativePath === root || relativePath.startsWith(`${root}/`)) {
        return true;
      }
    }
    return false;
  }

  private async syncFromDeviceForDeviceNode(deviceId: string): Promise<void> {
    await this.ensureActiveDevice();
    if (!this.workspaceFolder || !this.syncRootPath) {
      await this.refresh(false);
    }

    const board = getConnectedPyDevice(this.activeDeviceId);
    if (!board) {
      vscode.window.showWarningMessage('Connect to a board before syncing from device.');
      return;
    }

    if (!this.syncRootPath) {
      vscode.window.showWarningMessage('Map this device to a computer folder before syncing from device.');
      return;
    }

    const deviceEntries = await listDeviceEntries(board);
    if (this.activeDeviceId) {
      await this.pruneMissingDeviceSyncExclusions(this.activeDeviceId, deviceEntries);
    }
    const syncableDeviceEntries = this.filterSyncableEntries(deviceEntries);
    const deviceEntryMap = new Map(syncableDeviceEntries.map((entry) => [toRelativePath(entry.relativePath), entry]));

    const libraries = this.getDeviceLibraryMappings(deviceId).filter((library) => !library.missing);
    const libraryRoots = new Set(
      libraries
        .map((library) => toRelativePath(library.devicePath))
        .filter((root) => root.length > 0)
    );

    const syncOperations: SyncOperation[] = [];

    const mappedComputerEntries = this.filterSyncableEntries(await scanComputerSyncEntries(this.syncRootPath))
      .filter((entry) => !this.isWithinLibraryRoots(toRelativePath(entry.relativePath), libraryRoots));
    const mappedComputerEntryMap = new Map(mappedComputerEntries.map((entry) => [toRelativePath(entry.relativePath), entry]));
    const mappedDeviceEntries = syncableDeviceEntries
      .filter((entry) => {
        const relativePath = toRelativePath(entry.relativePath);
        return relativePath.length > 0 && !this.isWithinLibraryRoots(relativePath, libraryRoots);
      });
    const desiredMappedDevicePaths = new Set(mappedDeviceEntries.map((entry) => toRelativePath(entry.relativePath)));

    for (const entry of mappedDeviceEntries) {
      const relativePath = toRelativePath(entry.relativePath);
      const isExcluded = this.isPathExcludedFromSync(relativePath, this.activeDeviceId);
      const computerEntry = mappedComputerEntryMap.get(relativePath);
      if (!computerEntry) {
        const operation: Omit<SyncOperation, 'id'> = {
          action: 'create',
          relativePath,
          isDirectory: entry.isDirectory,
          excluded: isExcluded
        };
        syncOperations.push({ ...operation, id: this.toSyncOperationId(operation) });
        continue;
      }

      if (computerEntry.isDirectory !== entry.isDirectory) {
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

      const needsWrite = !entry.sha1 || !computerEntry.sha1 || entry.sha1 !== computerEntry.sha1;
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

    for (const entry of mappedComputerEntries) {
      const relativePath = toRelativePath(entry.relativePath);
      if (!relativePath || desiredMappedDevicePaths.has(relativePath)) {
        continue;
      }
      const isExcluded = this.isPathExcludedFromSync(relativePath, this.activeDeviceId);
      const operation: Omit<SyncOperation, 'id'> = {
        action: 'delete',
        relativePath,
        isDirectory: entry.isDirectory,
        excluded: isExcluded
      };
      syncOperations.push({ ...operation, id: this.toSyncOperationId(operation) });
    }

    for (const library of libraries) {
      const libraryDeviceRoot = toRelativePath(library.devicePath);
      if (!libraryDeviceRoot) {
        continue;
      }

      const computerEntries = this.filterSyncableEntries(await scanComputerSyncEntries(library.hostAbsolutePath));
      const computerEntryMap = new Map(computerEntries.map((entry) => [toRelativePath(entry.relativePath), entry]));
      const scopedDeviceEntries = syncableDeviceEntries
        .map((entry) => {
          const deviceRelativePath = toRelativePath(entry.relativePath);
          const scopedRelativePath = this.stripLibraryDeviceRoot(deviceRelativePath, libraryDeviceRoot);
          if (scopedRelativePath === undefined || scopedRelativePath.length === 0) {
            return undefined;
          }
          return {
            ...entry,
            relativePath: scopedRelativePath,
            deviceRelativePath
          };
        })
        .filter((entry): entry is (FileEntry & { deviceRelativePath: string }) => !!entry);

      const desiredLibraryPaths = new Set(scopedDeviceEntries.map((entry) => entry.relativePath));
      for (const entry of scopedDeviceEntries) {
        const displayPath = this.applyLibraryDeviceRoot(entry.relativePath, libraryDeviceRoot);
        const isExcluded = this.isPathExcludedFromSync(entry.deviceRelativePath, this.activeDeviceId);
        const computerEntry = computerEntryMap.get(entry.relativePath);
        if (!computerEntry) {
          const operation: Omit<SyncOperation, 'id'> = {
            action: 'create',
            relativePath: displayPath,
            isDirectory: entry.isDirectory,
            excluded: isExcluded,
            defaultChecked: false,
            deviceRelativePath: entry.deviceRelativePath,
            computerRootPath: library.hostAbsolutePath,
            computerRelativePath: entry.relativePath
          };
          syncOperations.push({ ...operation, id: this.toSyncOperationId(operation) });
          continue;
        }

        if (computerEntry.isDirectory !== entry.isDirectory) {
          const operation: Omit<SyncOperation, 'id'> = {
            action: 'modify',
            relativePath: displayPath,
            isDirectory: entry.isDirectory,
            excluded: isExcluded,
            defaultChecked: false,
            deviceRelativePath: entry.deviceRelativePath,
            computerRootPath: library.hostAbsolutePath,
            computerRelativePath: entry.relativePath
          };
          syncOperations.push({ ...operation, id: this.toSyncOperationId(operation) });
          continue;
        }

        if (entry.isDirectory) {
          continue;
        }

        const needsWrite = !entry.sha1 || !computerEntry.sha1 || entry.sha1 !== computerEntry.sha1;
        if (needsWrite) {
          const operation: Omit<SyncOperation, 'id'> = {
            action: 'modify',
            relativePath: displayPath,
            isDirectory: false,
            excluded: isExcluded,
            defaultChecked: false,
            deviceRelativePath: entry.deviceRelativePath,
            computerRootPath: library.hostAbsolutePath,
            computerRelativePath: entry.relativePath
          };
          syncOperations.push({ ...operation, id: this.toSyncOperationId(operation) });
        }
      }

      for (const entry of computerEntries) {
        const scopedRelativePath = toRelativePath(entry.relativePath);
        if (!scopedRelativePath || desiredLibraryPaths.has(scopedRelativePath)) {
          continue;
        }
        const deviceRelativePath = this.applyLibraryDeviceRoot(scopedRelativePath, libraryDeviceRoot);
        const isExcluded = this.isPathExcludedFromSync(deviceRelativePath, this.activeDeviceId);
        const operation: Omit<SyncOperation, 'id'> = {
          action: 'delete',
          relativePath: deviceRelativePath,
          isDirectory: entry.isDirectory,
          excluded: isExcluded,
          defaultChecked: false,
          deviceRelativePath,
          computerRootPath: library.hostAbsolutePath,
          computerRelativePath: scopedRelativePath
        };
        syncOperations.push({ ...operation, id: this.toSyncOperationId(operation) });
      }
    }

    const syncDialog = await this.pickSyncOperations(
      'Sync Preview',
      'DEVICE => COMPUTER',
      syncOperations
    );
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
        const computerRootPath = operation.computerRootPath ?? this.syncRootPath;
        const computerRelativePath = operation.computerRelativePath ?? operation.relativePath;
        await fs.rm(path.join(computerRootPath, computerRelativePath), { recursive: true, force: true });
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
        const computerRootPath = operation.computerRootPath ?? this.syncRootPath;
        const computerRelativePath = operation.computerRelativePath ?? operation.relativePath;
        const computerPath = path.join(computerRootPath, computerRelativePath);
        try {
          const stat = await fs.stat(computerPath);
          if (!stat.isDirectory()) {
            await fs.rm(computerPath, { recursive: true, force: true });
          }
        } catch {
          // Path does not exist; create below.
        }
        await fs.mkdir(computerPath, { recursive: true });
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
        const deviceRelativePath = operation.deviceRelativePath ?? operation.relativePath;
        const entry = deviceEntryMap.get(deviceRelativePath);
        if (!entry || entry.isDirectory) {
          syncDialog.setStatus(operation.id, 'skipped');
          continue;
        }
        const computerRootPath = operation.computerRootPath ?? this.syncRootPath;
        const computerRelativePath = operation.computerRelativePath ?? operation.relativePath;
        const computerPath = path.join(computerRootPath, computerRelativePath);
        try {
          const stat = await fs.stat(computerPath);
          if (stat.isDirectory()) {
            await fs.rm(computerPath, { recursive: true, force: true });
          }
        } catch {
          // Path does not exist; create parent below.
        }
        await fs.mkdir(path.dirname(computerPath), { recursive: true });
        const content = await readDeviceFile(board, deviceRelativePath);
        await fs.writeFile(computerPath, content);
        updatedDeviceFiles.push(deviceRelativePath);
        syncDialog.setStatus(operation.id, 'success');
      } catch (error) {
        failedCount += 1;
        syncDialog.setStatus(operation.id, 'error', this.toErrorMessage(error));
      }
    }

    await this.refresh(false);
    if (this.notifyDeviceFilesChanged) {
      await this.notifyDeviceFilesChanged(updatedDeviceFiles);
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
    if (!this.workspaceFolder || !this.syncRootPath) {
      await this.refresh(false);
    }

    const board = getConnectedPyDevice(this.activeDeviceId);
    if (!board) {
      vscode.window.showWarningMessage('Connect to a board before syncing to device.');
      return;
    }

    if (!this.syncRootPath) {
      vscode.window.showWarningMessage('Map this device to a computer folder before syncing to device.');
      return;
    }

    const computerEntries = await scanComputerSyncEntries(this.syncRootPath);
    const deviceEntries = await listDeviceEntries(board);
    if (this.activeDeviceId) {
      await this.pruneMissingDeviceSyncExclusions(this.activeDeviceId, deviceEntries);
    }
    const syncableComputerEntries = this.filterSyncableEntries(computerEntries);
    const syncableDeviceEntries = this.filterSyncableEntries(deviceEntries);
    const libraryRoots = new Set(
      this.getDeviceLibraryMappings(this.activeDeviceId ?? '')
        .filter((library) => !library.missing)
        .map((library) => toRelativePath(library.devicePath))
        .filter((root) => root.length > 0)
    );
    const scopedComputerEntries = syncableComputerEntries.filter(
      (entry) => !this.isWithinLibraryRoots(toRelativePath(entry.relativePath), libraryRoots)
    );
    const scopedDeviceEntries = syncableDeviceEntries.filter(
      (entry) => !this.isWithinLibraryRoots(toRelativePath(entry.relativePath), libraryRoots)
    );
    const computerEntryMap = new Map(scopedComputerEntries.map((entry) => [toRelativePath(entry.relativePath), entry]));
    const deviceEntryMap = new Map(scopedDeviceEntries.map((entry) => [toRelativePath(entry.relativePath), entry]));
    const protectedDevicePaths = this.getProtectedSyncPaths(scopedDeviceEntries, this.activeDeviceId);
    const desiredComputerPaths = new Set(scopedComputerEntries.map((entry) => toRelativePath(entry.relativePath)));
    const syncOperations: SyncOperation[] = [];

    for (const entry of scopedComputerEntries) {
      const relativePath = toRelativePath(entry.relativePath);
      if (!relativePath) {
        continue;
      }
      const isExcluded = this.isPathExcludedFromSync(relativePath, this.activeDeviceId);
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

    for (const entry of scopedDeviceEntries) {
      const relativePath = toRelativePath(entry.relativePath);
      if (!relativePath) {
        continue;
      }
      if (desiredComputerPaths.has(relativePath)) {
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

    const syncDialog = await this.pickSyncOperations(
      'Sync Preview',
      'COMPUTER => DEVICE',
      syncOperations
    );
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
        if (this.notifyDevicePathDeleted) {
          await this.notifyDevicePathDeleted(operation.relativePath, operation.isDirectory);
        }
        syncDialog.setStatus(operation.id, 'success');
      } catch (error) {
        failedCount += 1;
        syncDialog.setStatus(operation.id, 'error', this.toErrorMessage(error));
      }
    }

    const computerDirectories = selectedOperations
      .filter((operation) => operation.action !== 'delete' && operation.isDirectory)
      .sort((a, b) => a.relativePath.split('/').length - b.relativePath.split('/').length);
    for (const directory of computerDirectories) {
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
        const computerEntry = computerEntryMap.get(operation.relativePath);
        if (!computerEntry || computerEntry.isDirectory) {
          syncDialog.setStatus(operation.id, 'skipped');
          continue;
        }
        const computerPath = path.join(this.syncRootPath, operation.relativePath);
        const content = await fs.readFile(computerPath);
        await writeDeviceFile(board, operation.relativePath, Buffer.from(content));
        writtenDeviceFiles.push(operation.relativePath);
        syncDialog.setStatus(operation.id, 'success');
      } catch (error) {
        failedCount += 1;
        syncDialog.setStatus(operation.id, 'error', this.toErrorMessage(error));
      }
    }

    this.computerEntries = computerEntries;
    this.deviceEntries = await listDeviceEntries(board);
    this.syncStates = buildSyncStateMap(this.filterSyncableEntries(this.computerEntries), this.filterSyncableEntries(this.deviceEntries));
    this.onDidChangeDataEmitter.fire();
    if (this.notifyDeviceFilesChanged) {
      await this.notifyDeviceFilesChanged(writtenDeviceFiles);
    }

    const msg = failedCount > 0
      ? `Sync to device finished with ${failedCount} error(s).`
      : 'Sync to device complete.';
    await syncDialog.finish(msg);
    vscode.window.showInformationMessage(msg);
    logChannelOutput(msg, true);
  }

  async syncNodeFromDevice(node?: SyncNode): Promise<void> {
    const targetNode = this.resolveTargetNode(node);
    await this.ensureActiveDevice(targetNode);
    if (targetNode?.data.isDeviceIdNode && targetNode.data.deviceId) {
      await this.syncFromDeviceForDeviceNode(targetNode.data.deviceId);
      return;
    }
    const scope = this.resolveNodeSyncScope(targetNode);
    if (!targetNode || targetNode.data.isRoot) {
      await this.syncFromDevice();
      return;
    }
    if (this.isNodeExcludedFromSync(targetNode)) {
      const excludedPath = targetNode ? toRelativePath(targetNode.data.relativePath) : '';
      vscode.window.showInformationMessage(`File is excluded from sync: /${excludedPath}`);
      return;
    }
    if (targetNode?.data.side === 'computer') {
      await this.pullFromDevicePath(targetNode.data.relativePath, targetNode.data.isDirectory, scope);
      return;
    }

    const relativePath = targetNode?.data.relativePath ?? '';
    const isDirectory = targetNode ? targetNode.data.isDirectory : true;
    await this.pullFromDevicePath(relativePath, isDirectory, scope);
  }

  async syncNodeToDevice(node?: SyncNode): Promise<void> {
    const targetNode = this.resolveTargetNode(node);
    await this.ensureActiveDevice(targetNode);
    const scope = this.resolveNodeSyncScope(targetNode);
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
      await this.pushToDevicePath(targetNode.data.relativePath, targetNode.data.isDirectory, scope);
      return;
    }

    const relativePath = targetNode?.data.relativePath ?? '';
    const isDirectory = targetNode ? targetNode.data.isDirectory : true;
    await this.pushToDevicePath(relativePath, isDirectory, scope);
  }

  async createSyncFile(node?: SyncNode): Promise<void> {
    const targetNode = this.resolveTargetNode(node);
    await this.ensureActiveDevice(targetNode);
    if (targetNode?.data.side === 'device') {
      await this.createDeviceFile(targetNode);
      return;
    }

    await this.createComputerFile(targetNode);
  }

  async createSyncFolder(node?: SyncNode): Promise<void> {
    const targetNode = this.resolveTargetNode(node);
    await this.ensureActiveDevice(targetNode);
    if (targetNode?.data.side === 'device') {
      await this.createDeviceFolder(targetNode);
      return;
    }

    await this.createComputerFolder(targetNode);
  }

  async renameSyncPath(node?: SyncNode): Promise<void> {
    const targetNode = this.resolveTargetNode(node);
    await this.ensureActiveDevice(targetNode);
    if (!targetNode || targetNode.data.isRoot || targetNode.data.isIndicator) {
      vscode.window.showWarningMessage('Select a file or folder to rename.');
      return;
    }
    if (targetNode.data.isLibraryNode) {
      vscode.window.showWarningMessage('Library root names are derived from mapped host folders. Remove and re-add the mapping to change it.');
      return;
    }

    if (targetNode.data.side === 'device') {
      await this.renameDevicePath(targetNode);
      return;
    }

    await this.renameComputerPath(targetNode);
  }

  async deleteSyncPath(node?: SyncNode): Promise<void> {
    const targetNode = this.resolveTargetNode(node);
    await this.ensureActiveDevice(targetNode);
    if (!targetNode || targetNode.data.isRoot || targetNode.data.isIndicator) {
      vscode.window.showWarningMessage('Select a file or folder to delete.');
      return;
    }
    if (targetNode.data.isLibraryNode) {
      vscode.window.showWarningMessage('Use "Remove device library folder" to remove a library mapping.');
      return;
    }

    if (targetNode.data.side === 'device') {
      await this.deleteDevicePath(targetNode);
      return;
    }

    await this.deleteComputerPath(targetNode);
  }

  private isTextTabForUri(tab: vscode.Tab, uri: vscode.Uri): boolean {
    return tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString();
  }

  private isUriOpenInPinnedTextTab(uri: vscode.Uri): boolean {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (this.isTextTabForUri(tab, uri) && tab.isPinned) {
          return true;
        }
      }
    }
    return false;
  }

  private async showTextDocumentWithExplorerBehavior(
    document: vscode.TextDocument,
    options?: OpenEditorOptions
  ): Promise<void> {
    const explorerClick = options?.explorerClick ?? false;
    if (!explorerClick) {
      await vscode.window.showTextDocument(document, { preview: false });
      return;
    }

    const uri = document.uri;
    const uriKey = uri.toString();
    const nowMs = Date.now();
    const isRapidRepeatOnSameUri = this.lastExplorerOpenUri === uriKey && (nowMs - this.lastExplorerOpenAtMs) <= 500;
    this.lastExplorerOpenUri = uriKey;
    this.lastExplorerOpenAtMs = nowMs;

    if (isRapidRepeatOnSameUri) {
      await vscode.window.showTextDocument(document, { preview: false });
      return;
    }

    const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
    const isActiveSameFile = !!activeTab && this.isTextTabForUri(activeTab, uri);

    if (isActiveSameFile) {
      await vscode.window.showTextDocument(document, { preview: false });
      return;
    }

    if (this.isUriOpenInPinnedTextTab(uri)) {
      await vscode.window.showTextDocument(document, { preview: false });
      return;
    }

    await vscode.window.showTextDocument(document, { preview: true });
  }

  async openComputerNode(node: SyncNode, options?: OpenEditorOptions): Promise<void> {
    await this.ensureActiveDevice(node);
    const computerRootPath = this.resolveComputerReadRootPath(node);
    if (!computerRootPath) {
      return;
    }

    const fullPath = path.join(computerRootPath, node.data.relativePath);
    const stat = await fs.stat(fullPath);
    if (stat.isDirectory()) {
      return;
    }

    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(fullPath));
    await this.showTextDocumentWithExplorerBehavior(document, options);
  }

  async pullDeviceNodeAndOpen(node: SyncNode, options?: OpenEditorOptions): Promise<void> {
    const deviceId = await this.ensureActiveDevice(node);
    if (!deviceId || !getConnectedPyDevice(deviceId)) {
      vscode.window.showWarningMessage('Connect to a board before opening a device file.');
      return;
    }

    if (node.data.isDirectory) {
      return;
    }

    const deviceSegment = encodeURIComponent(this.getDeviceUriSegment(deviceId));
    const deviceRelativePath = toRelativePath(node.data.relativePath);
    const deviceUri = vscode.Uri.parse(`${deviceDocumentScheme}:/${deviceSegment}/${deviceRelativePath}?deviceId=${encodeURIComponent(deviceId)}`);
    const document = await vscode.workspace.openTextDocument(deviceUri);
    await this.showTextDocumentWithExplorerBehavior(document, options);
  }

  async openDeviceFile(node?: SyncNode, options?: OpenEditorOptions): Promise<void> {
    await this.ensureActiveDevice(node);
    if (node) {
      await this.pullDeviceNodeAndOpen(node, options);
      return;
    }

    const board = getConnectedPyDevice(this.activeDeviceId);
    if (!board) {
      vscode.window.showWarningMessage('Connect to a board before opening a device file.');
      return;
    }

    const files = this.deviceEntries
      .filter((entry) => !entry.isDirectory && entry.relativePath.length > 0)
      .sort((a, b) => a.relativePath.localeCompare(b.relativePath));

    if (files.length === 0) {
      vscode.window.showInformationMessage('No device files available to open.');
      return;
    }

    const selected = await vscode.window.showQuickPick(
      files.map((item) => ({ label: item.relativePath })),
      {
        placeHolder: 'Select a device file to open',
        canPickMany: false,
        ignoreFocusOut: true
      }
    );

    if (!selected) {
      return;
    }

    const quickPickNode = new SyncNode(
      {
        side: 'device',
        relativePath: selected.label,
        isDirectory: false,
        deviceId: this.activeDeviceId
      },
      selected.label,
      vscode.TreeItemCollapsibleState.None
    );

    await this.pullDeviceNodeAndOpen(quickPickNode, options);
  }

  async compareDeviceWithComputer(node?: SyncNode): Promise<void> {
    const targetNode = this.resolveTargetNode(node);
    await this.ensureActiveDevice(targetNode);
    if (targetNode) {
      await this.openDeviceDiff(targetNode);
      return;
    }

    const board = getConnectedPyDevice(this.activeDeviceId);
    if (!board) {
      vscode.window.showWarningMessage('Connect to a board before comparing a device file.');
      return;
    }

    const files = this.deviceEntries
      .filter((entry) => !entry.isDirectory && entry.relativePath.length > 0)
      .sort((a, b) => a.relativePath.localeCompare(b.relativePath));

    if (files.length === 0) {
      vscode.window.showInformationMessage('No device files available to compare.');
      return;
    }

    const selected = await vscode.window.showQuickPick(
      files.map((item) => ({ label: item.relativePath })),
      {
        placeHolder: 'Select a device file to compare',
        canPickMany: false,
        ignoreFocusOut: true
      }
    );

    if (!selected) {
      return;
    }

    const quickPickNode = new SyncNode(
      {
        side: 'device',
        relativePath: selected.label,
        isDirectory: false,
        deviceId: this.activeDeviceId
      },
      selected.label,
      vscode.TreeItemCollapsibleState.None
    );

    await this.openDeviceDiff(quickPickNode);
  }

  async compareDeviceFiles(node?: SyncNode): Promise<void> {
    const targetNode = this.resolveTargetNode(node);
    const deviceId = await this.ensureActiveDevice(targetNode);
    if (!deviceId) {
      vscode.window.showWarningMessage('Select a device before comparing files.');
      return;
    }

    const board = getConnectedPyDevice(deviceId);
    if (!board) {
      vscode.window.showWarningMessage('Connect to a board before comparing files.');
      return;
    }

    const scopedTargetNode = targetNode?.data.side === 'device' ? targetNode : undefined;
    const targetRelativePath = scopedTargetNode
      && !scopedTargetNode.data.isRoot
      && !scopedTargetNode.data.isDeviceIdNode
      ? toRelativePath(scopedTargetNode.data.relativePath)
      : '';
    const rows = await this.buildDeviceFileCompareRows(deviceId, board, targetRelativePath);
    if (rows.length === 0) {
      const targetLabel = targetRelativePath ? ` in /${targetRelativePath}` : '';
      vscode.window.showInformationMessage(`No files available to compare${targetLabel}.`);
      return;
    }

    const hasDifferences = rows.some((row) => row.status !== 'match');
    const syncTargetNode = scopedTargetNode ?? new SyncNode(
      {
        side: 'device',
        relativePath: '',
        isDirectory: true,
        deviceId,
        isDeviceIdNode: true
      },
      this.getDeviceDisplayName(deviceId),
      vscode.TreeItemCollapsibleState.Collapsed
    );

    const panel = vscode.window.createWebviewPanel(
      'pydevice.compareFiles',
      `Compare Files: ${this.getDeviceDisplayName(deviceId)}`,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true }
    );
    panel.webview.html = this.renderDeviceFileCompareHtml(deviceId, rows, hasDifferences);
    panel.webview.onDidReceiveMessage((message: unknown) => {
      if (!message || typeof message !== 'object') {
        return;
      }
      const typed = message as {
        type?: string;
        rowId?: string;
      };
      if (typed.type !== 'compare' || typeof typed.rowId !== 'string') {
        if (typed.type === 'sync_to_device') {
          void this.syncNodeToDevice(syncTargetNode);
          return;
        }
        if (typed.type === 'sync_from_device') {
          void this.syncNodeFromDevice(syncTargetNode);
          return;
        }
        if (typed.type === 'close') {
          panel.dispose();
        }
        return;
      }
      const row = rows.find((item) => item.id === typed.rowId);
      if (!row || row.status !== 'mismatch') {
        return;
      }

      const compareNode = new SyncNode(
        {
          side: 'device',
          relativePath: row.deviceRelativePath,
          isDirectory: false,
          deviceId,
          libraryHostFolder: row.libraryHostFolder,
          libraryDeviceRoot: row.libraryDeviceRoot
        },
        row.deviceRelativePath,
        vscode.TreeItemCollapsibleState.None
      );
      void this.openDeviceDiff(compareNode);
    });
  }

  async createDeviceFile(node?: SyncNode): Promise<void> {
    await this.ensureActiveDevice(node);
    const deviceId = this.activeDeviceId;
    const board = getConnectedPyDevice(this.activeDeviceId);
    if (!board) {
      vscode.window.showWarningMessage('Connect to a board before creating a device file.');
      return;
    }

    const parentPath = this.getDeviceCreateParentPath(node);
    const fileName = await vscode.window.showInputBox({
      title: 'Create Device File',
      prompt: parentPath ? `Create in /${parentPath}` : 'Create in /',
      placeHolder: 'filename.py',
      ignoreFocusOut: true,
      validateInput: (value) => this.validateDeviceName(value)
    });

    if (!fileName) {
      return;
    }

    const relativePath = this.joinDevicePath(parentPath, fileName);
    await writeDeviceFile(board, relativePath, Buffer.alloc(0));
    const confirmed = await this.waitForDeviceEntry(board, relativePath, false);
    await this.refresh(true);
    await this.revealNode({ side: 'device', relativePath: parentPath, deviceId });
    if (!confirmed) {
      const warning = `Timed out waiting for created device file: /${relativePath}`;
      vscode.window.showWarningMessage(warning);
      logChannelOutput(warning, true);
      return;
    }
    if (this.notifyDeviceFilesChanged) {
      await this.notifyDeviceFilesChanged([relativePath]);
    }
    const createdNode = new SyncNode(
      {
        side: 'device',
        relativePath,
        isDirectory: false,
        deviceId
      },
      path.posix.basename(relativePath),
      vscode.TreeItemCollapsibleState.None
    );
    await this.pullDeviceNodeAndOpen(createdNode);

    const msg = `Created device file: /${relativePath}`;
    vscode.window.showInformationMessage(msg);
    logChannelOutput(msg, true);
  }

  async createDeviceFolder(node?: SyncNode): Promise<void> {
    await this.ensureActiveDevice(node);
    const deviceId = this.activeDeviceId;
    const board = getConnectedPyDevice(this.activeDeviceId);
    if (!board) {
      vscode.window.showWarningMessage('Connect to a board before creating a device folder.');
      return;
    }

    const parentPath = this.getDeviceCreateParentPath(node);
    const folderName = await vscode.window.showInputBox({
      title: 'Create Device Folder',
      prompt: parentPath ? `Create in /${parentPath}` : 'Create in /',
      placeHolder: 'folder',
      ignoreFocusOut: true,
      validateInput: (value) => this.validateDeviceName(value)
    });

    if (!folderName) {
      return;
    }

    const relativePath = this.joinDevicePath(parentPath, folderName);
    await createDeviceDirectory(board, relativePath);
    const confirmed = await this.waitForDeviceEntry(board, relativePath, true);
    await this.refresh(true);
    await this.revealNode({ side: 'device', relativePath: parentPath, deviceId });
    if (!confirmed) {
      const warning = `Timed out waiting for created device folder: /${relativePath}`;
      vscode.window.showWarningMessage(warning);
      logChannelOutput(warning, true);
      return;
    }

    const msg = `Created device folder: /${relativePath}`;
    vscode.window.showInformationMessage(msg);
    logChannelOutput(msg, true);
  }

  async renameDevicePath(node?: SyncNode): Promise<void> {
    node = this.resolveTargetNode(node);
    await this.ensureActiveDevice(node);
    if (!node || node.data.side !== 'device') {
      vscode.window.showWarningMessage('Select a device file or folder to rename.');
      return;
    }

    const board = getConnectedPyDevice(this.activeDeviceId);
    if (!board) {
      vscode.window.showWarningMessage('Connect to a board before renaming device items.');
      return;
    }

    const currentPath = toRelativePath(node.data.relativePath);
    const currentName = path.posix.basename(currentPath);
    const parentPath = path.posix.dirname(currentPath) === '.' ? '' : path.posix.dirname(currentPath);
    const nextName = await vscode.window.showInputBox({
      title: `Rename Device ${node.data.isDirectory ? 'Folder' : 'File'}`,
      prompt: `Current: /${currentPath}`,
      value: currentName,
      ignoreFocusOut: true,
      validateInput: (value) => this.validateDeviceName(value)
    });

    if (!nextName || nextName === currentName) {
      return;
    }

    const nextPath = this.joinDevicePath(parentPath, nextName);
    await renameDevicePath(board, currentPath, nextPath);

    if (this.notifyDevicePathDeleted) {
      await this.notifyDevicePathDeleted(currentPath, node.data.isDirectory);
    }
    await this.refresh(true);
    if (!node.data.isDirectory && this.notifyDeviceFilesChanged) {
      await this.notifyDeviceFilesChanged([nextPath]);
    }

    const msg = `Renamed device path: /${currentPath} -> /${nextPath}`;
    vscode.window.showInformationMessage(msg);
    logChannelOutput(msg, true);
  }

  async deleteDevicePath(node?: SyncNode): Promise<void> {
    node = this.resolveTargetNode(node);
    await this.ensureActiveDevice(node);
    if (!node || node.data.side !== 'device') {
      vscode.window.showWarningMessage('Select a device file or folder to delete.');
      return;
    }

    const board = getConnectedPyDevice(this.activeDeviceId);
    if (!board) {
      vscode.window.showWarningMessage('Connect to a board before deleting device items.');
      return;
    }

    const targetPath = toRelativePath(node.data.relativePath);
    const action = await vscode.window.showWarningMessage(
      `Delete device ${node.data.isDirectory ? 'folder' : 'file'} "/${targetPath}"?`,
      { modal: true },
      'Delete'
    );
    if (action !== 'Delete') {
      return;
    }

    try {
      await deleteDevicePath(board, targetPath);
    } catch (error) {
      if (this.isDevicePathNotFoundError(error)) {
        await this.refresh(true);
        const msg = `Device path already missing: /${targetPath}`;
        vscode.window.showInformationMessage(msg);
        logChannelOutput(msg, true);
        return;
      }
      throw error;
    }
    if (this.activeDeviceId) {
      await this.removeSyncExclusionsForDeletedDevicePath(this.activeDeviceId, targetPath, node.data.isDirectory);
    }
    if (this.notifyDevicePathDeleted) {
      await this.notifyDevicePathDeleted(targetPath, node.data.isDirectory);
    }
    await this.refresh(true);

    const msg = `Deleted device path: /${targetPath}`;
    vscode.window.showInformationMessage(msg);
    logChannelOutput(msg, true);
  }

  private resolveTargetNode(node?: SyncNode): SyncNode | undefined {
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
    const deviceRelativePath = operation.deviceRelativePath ?? operation.relativePath;
    const computerRelativePath = operation.computerRelativePath ?? operation.relativePath;
    const computerRootPath = operation.computerRootPath ?? '';
    return `${operation.action}:${type}:${excluded}:${deviceRelativePath}:${computerRelativePath}:${computerRootPath}`;
  }

  private async pickSyncOperations(
    title: string,
    directionLabel: string,
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
        checked: operation.defaultChecked ?? !operation.excluded
      }));

    const panel = vscode.window.createWebviewPanel(
      'pydevice.syncPreview',
      title,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true }
    );

    const rowsJson = JSON.stringify(rows);
    const titleText = this.escapeHtml(title);
    const directionText = this.escapeHtml(directionLabel);
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
    .direction {
      margin: 0 0 12px;
      padding: 10px 12px;
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.4px;
      text-transform: uppercase;
      border: 1px solid var(--vscode-focusBorder);
      background: var(--vscode-editor-inactiveSelectionBackground);
      color: var(--vscode-foreground);
    }
    .hint { margin: 0 0 12px; opacity: 0.9; }
    table { width: 100%; border-collapse: collapse; border: 1px solid var(--vscode-editorWidget-border); table-layout: fixed; }
    th, td { padding: 8px 10px; border-bottom: 1px solid var(--vscode-editorWidget-border); vertical-align: middle; user-select: text; }
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
    <div class="direction">Sync direction: ${directionText}</div>
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

  private isDevicePathNotFoundError(error: unknown): boolean {
    const message = this.toErrorMessage(error).toLocaleLowerCase();
    return message.includes('path not found')
      || message.includes('no such file')
      || message.includes('enoent')
      || message.includes('not found');
  }

  private isIgnoredSyncPath(relativePath: string): boolean {
    const normalised = toRelativePath(relativePath);
    if (!normalised) {
      return false;
    }
    return normalised.split('/').includes('__pycache__');
  }

  private filterSyncableEntries(entries: FileEntry[]): FileEntry[] {
    return entries.filter((entry) => !this.isIgnoredSyncPath(entry.relativePath));
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

  private isNodeExcludedFromSync(node: SyncNode | undefined): boolean {
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

    // COMPUTER-side nodes are device-agnostic and may be mapped to multiple devices,
    // so exclusion state must not be inferred from the active device.
    if (data.side === 'computer') {
      return false;
    }

    const deviceId = data.deviceId ?? this.activeDeviceId;
    return this.isPathExcludedFromSync(data.relativePath, deviceId);
  }

  getDeviceFileCompareAvailability(data: NodeData): DeviceFileCompareAvailability {
    if (data.side !== 'device' || data.isDirectory || data.isRoot || data.isIndicator) {
      return 'available';
    }

    const deviceId = data.deviceId;
    if (!deviceId) {
      return 'unmapped';
    }

    if (data.libraryHostFolder) {
      const library = this.getLibraryMappingByHostFolder(deviceId, data.libraryHostFolder);
      if (library?.missing || data.isLibraryMissing) {
        return 'hostMissing';
      }
      if (library || this.resolveWorkspaceRelativePath(data.libraryHostFolder)) {
        return 'available';
      }
      return 'unmapped';
    }

    if (!this.syncRootByDeviceId.get(deviceId)) {
      return 'unmapped';
    }

    const relativePath = toRelativePath(data.relativePath);
    const computerEntries = this.computerEntriesByDeviceId.get(deviceId) ?? [];
    const hostFileExists = computerEntries.some(
      (entry) => !entry.isDirectory && toRelativePath(entry.relativePath) === relativePath
    );
    return hostFileExists ? 'available' : 'hostMissing';
  }

  async excludeDeviceFileFromSync(node?: SyncNode): Promise<void> {
    const targetNode = this.resolveTargetNode(node);
    await this.ensureActiveDevice(targetNode);
    if (!targetNode || targetNode.data.isRoot || targetNode.data.isIndicator) {
      vscode.window.showWarningMessage('Select a file or folder to exclude from sync.');
      return;
    }

    const deviceId = this.getNodeDeviceId(targetNode);
    if (!deviceId) {
      vscode.window.showWarningMessage('Select a mapped device path to exclude from sync.');
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

  async removeDeviceFileFromSyncExclusion(node?: SyncNode): Promise<void> {
    const targetNode = this.resolveTargetNode(node);
    await this.ensureActiveDevice(targetNode);
    if (!targetNode || targetNode.data.isRoot || targetNode.data.isIndicator) {
      vscode.window.showWarningMessage('Select an excluded file or folder to remove from sync exclusions.');
      return;
    }

    const deviceId = this.getNodeDeviceId(targetNode);
    if (!deviceId) {
      vscode.window.showWarningMessage('Select a mapped device path to update sync exclusions.');
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

  private async pullFromDevicePath(
    targetPath: string,
    includeDescendants: boolean,
    scope?: { computerRootPath: string; libraryDeviceRoot?: string }
  ): Promise<void> {
    await this.ensureActiveDevice();
    if (!this.workspaceFolder || (!this.syncRootPath && !scope?.computerRootPath)) {
      await this.refresh(false);
    }

    const board = getConnectedPyDevice(this.activeDeviceId);
    if (!board) {
      vscode.window.showWarningMessage('Connect to a board before syncing from device.');
      return;
    }

    const computerRootPath = scope?.computerRootPath ?? this.syncRootPath;
    if (!computerRootPath) {
      vscode.window.showWarningMessage('Map this device to a computer folder before syncing from device.');
      return;
    }

    const libraryDeviceRoot = scope?.libraryDeviceRoot;
    const normalisedTarget = toRelativePath(targetPath);
    const scopedTarget = libraryDeviceRoot
      ? this.stripLibraryDeviceRoot(normalisedTarget, libraryDeviceRoot)
      : normalisedTarget;
    if (scopedTarget === undefined) {
      vscode.window.showWarningMessage('Selected path is outside the mapped library folder.');
      return;
    }

    const deviceEntries = await listDeviceEntries(board);
    const syncableDeviceEntries = this.filterSyncableEntries(deviceEntries);
    const scopedEntries = syncableDeviceEntries
      .map((entry) => {
        const scopedRelativePath = libraryDeviceRoot
          ? this.stripLibraryDeviceRoot(entry.relativePath, libraryDeviceRoot)
          : toRelativePath(entry.relativePath);
        if (scopedRelativePath === undefined) {
          return undefined;
        }
        return {
          ...entry,
          relativePath: scopedRelativePath,
          deviceRelativePath: libraryDeviceRoot
            ? this.applyLibraryDeviceRoot(scopedRelativePath, libraryDeviceRoot)
            : toRelativePath(entry.relativePath)
        };
      })
      .filter((entry): entry is (FileEntry & { deviceRelativePath: string }) =>
        !!entry &&
        entry.relativePath.length > 0 &&
        this.matchesTarget(entry.relativePath, scopedTarget, includeDescendants)
      );
    const desiredPaths = new Set(scopedEntries.map((entry) => entry.relativePath));

    const existingComputerEntries = this.filterSyncableEntries(await scanComputerSyncEntries(computerRootPath));
    const staleComputerEntries = existingComputerEntries
      .filter(
        (entry) =>
          entry.relativePath.length > 0 &&
          this.matchesTarget(entry.relativePath, scopedTarget, includeDescendants) &&
          !desiredPaths.has(entry.relativePath) &&
          !this.isPathExcludedFromSync(
            libraryDeviceRoot ? this.applyLibraryDeviceRoot(entry.relativePath, libraryDeviceRoot) : entry.relativePath,
            this.activeDeviceId
          )
      )
      .sort((a, b) => b.relativePath.length - a.relativePath.length);
    for (const staleEntry of staleComputerEntries) {
      const stalePath = path.join(computerRootPath, staleEntry.relativePath);
      await fs.rm(stalePath, { recursive: true, force: true });
    }

    for (const entry of scopedEntries) {
      if (this.isPathExcludedFromSync(entry.deviceRelativePath, this.activeDeviceId)) {
        continue;
      }
      const computerPath = path.join(computerRootPath, entry.relativePath);
      if (entry.isDirectory) {
        try {
          const stat = await fs.stat(computerPath);
          if (!stat.isDirectory()) {
            await fs.rm(computerPath, { recursive: true, force: true });
          }
        } catch {
          // Path does not exist; create it below.
        }
        await fs.mkdir(computerPath, { recursive: true });
        continue;
      }

      await fs.mkdir(path.dirname(computerPath), { recursive: true });
      const content = await readDeviceFile(board, entry.deviceRelativePath);
      await fs.writeFile(computerPath, content);
    }

    this.deviceEntries = deviceEntries;
    this.computerEntries = await scanComputerSyncEntries(computerRootPath);
    this.syncStates = buildSyncStateMap(this.filterSyncableEntries(this.computerEntries), this.filterSyncableEntries(this.deviceEntries));
    this.onDidChangeDataEmitter.fire();

    const targetLabel = scopedTarget ? `/${scopedTarget}` : '/';
    const msg = `Sync from device complete for ${targetLabel}.`;
    vscode.window.showInformationMessage(msg);
    logChannelOutput(msg, true);
  }

  private async pushToDevicePath(
    targetPath: string,
    includeDescendants: boolean,
    scope?: { computerRootPath: string; libraryDeviceRoot?: string }
  ): Promise<void> {
    await this.ensureActiveDevice();
    if (!this.workspaceFolder || (!this.syncRootPath && !scope?.computerRootPath)) {
      await this.refresh(false);
    }

    const board = getConnectedPyDevice(this.activeDeviceId);
    if (!board) {
      vscode.window.showWarningMessage('Connect to a board before syncing to device.');
      return;
    }

    const computerRootPath = scope?.computerRootPath ?? this.syncRootPath;
    if (!computerRootPath) {
      vscode.window.showWarningMessage('Map this device to a computer folder before syncing to device.');
      return;
    }

    const libraryDeviceRoot = scope?.libraryDeviceRoot;
    const normalisedTarget = toRelativePath(targetPath);
    const scopedTarget = libraryDeviceRoot
      ? this.stripLibraryDeviceRoot(normalisedTarget, libraryDeviceRoot)
      : normalisedTarget;
    if (scopedTarget === undefined) {
      vscode.window.showWarningMessage('Selected path is outside the mapped library folder.');
      return;
    }

    const computerEntries = await scanComputerSyncEntries(computerRootPath);
    const deviceEntries = await listDeviceEntries(board);
    const syncableComputerEntries = this.filterSyncableEntries(computerEntries);
    const syncableDeviceEntries = this.filterSyncableEntries(deviceEntries);
    const scopedEntries = syncableComputerEntries.filter(
      (entry) => entry.relativePath.length > 0 && this.matchesTarget(entry.relativePath, scopedTarget, includeDescendants)
    );
    const scopedDeviceEntries = syncableDeviceEntries
      .map((entry) => {
        const scopedRelativePath = libraryDeviceRoot
          ? this.stripLibraryDeviceRoot(entry.relativePath, libraryDeviceRoot)
          : toRelativePath(entry.relativePath);
        if (scopedRelativePath === undefined) {
          return undefined;
        }
        return {
          ...entry,
          relativePath: scopedRelativePath,
          deviceRelativePath: libraryDeviceRoot
            ? this.applyLibraryDeviceRoot(scopedRelativePath, libraryDeviceRoot)
            : toRelativePath(entry.relativePath)
        };
      })
      .filter((entry): entry is (FileEntry & { deviceRelativePath: string }) =>
        !!entry &&
        entry.relativePath.length > 0 &&
        this.matchesTarget(entry.relativePath, scopedTarget, includeDescendants)
      );
    const desiredComputerPaths = new Set(scopedEntries.map((entry) => entry.relativePath));
    const staleDeviceEntries = scopedDeviceEntries
      .filter((entry) => {
        if (desiredComputerPaths.has(entry.relativePath)) {
          return false;
        }
        if (this.isPathExcludedFromSync(entry.deviceRelativePath, this.activeDeviceId)) {
          return false;
        }
        return true;
      })
      .sort((a, b) => b.relativePath.length - a.relativePath.length);
    for (const staleEntry of staleDeviceEntries) {
      await deleteDevicePath(board, staleEntry.deviceRelativePath);
      if (this.activeDeviceId) {
        await this.removeSyncExclusionsForDeletedDevicePath(this.activeDeviceId, staleEntry.deviceRelativePath, staleEntry.isDirectory);
      }
      if (this.notifyDevicePathDeleted) {
        await this.notifyDevicePathDeleted(staleEntry.deviceRelativePath, staleEntry.isDirectory);
      }
    }

    const computerDirectories = scopedEntries
      .filter((entry) => entry.isDirectory)
      .sort((a, b) => a.relativePath.split('/').length - b.relativePath.split('/').length);
    for (const directory of computerDirectories) {
      const deviceDirectoryPath = libraryDeviceRoot
        ? this.applyLibraryDeviceRoot(directory.relativePath, libraryDeviceRoot)
        : directory.relativePath;
      await createDeviceDirectory(board, deviceDirectoryPath);
    }

    const writtenDeviceFiles: string[] = [];
    for (const entry of scopedEntries) {
      if (entry.isDirectory) {
        continue;
      }
      const deviceFilePath = libraryDeviceRoot
        ? this.applyLibraryDeviceRoot(entry.relativePath, libraryDeviceRoot)
        : entry.relativePath;
      if (this.isPathExcludedFromSync(deviceFilePath, this.activeDeviceId)) {
        continue;
      }

      const computerPath = path.join(computerRootPath, entry.relativePath);
      const content = await fs.readFile(computerPath);
      await writeDeviceFile(board, deviceFilePath, Buffer.from(content));
      writtenDeviceFiles.push(deviceFilePath);
    }

    this.computerEntries = computerEntries;
    this.deviceEntries = await listDeviceEntries(board);
    this.syncStates = buildSyncStateMap(this.filterSyncableEntries(this.computerEntries), this.filterSyncableEntries(this.deviceEntries));
    this.onDidChangeDataEmitter.fire();
    if (this.notifyDeviceFilesChanged) {
      await this.notifyDeviceFilesChanged(writtenDeviceFiles);
    }

    const targetLabel = scopedTarget ? `/${scopedTarget}` : '/';
    const msg = `Sync to device complete for ${targetLabel}.`;
    vscode.window.showInformationMessage(msg);
    logChannelOutput(msg, true);
  }

  private getComputerParentPath(node?: SyncNode): string {
    if (!node || node.data.side !== 'computer' || node.data.isRoot) {
      return '';
    }

    if (node.data.isDirectory) {
      return toRelativePath(node.data.relativePath);
    }

    const parent = path.posix.dirname(node.data.relativePath);
    return parent === '.' ? '' : toRelativePath(parent);
  }

  private validateComputerName(value: string): string | undefined {
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

  private async resolveComputerWriteRootPath(): Promise<string | undefined> {
    if (this.syncRootPath) {
      return this.syncRootPath;
    }

    const hostRootPath = this.getHostSyncRootPath();
    if (!hostRootPath) {
      return undefined;
    }
    await fs.mkdir(hostRootPath, { recursive: true });
    return hostRootPath;
  }

  private resolveNodeSyncScope(node?: SyncNode): { computerRootPath: string; libraryDeviceRoot?: string } | undefined {
    if (node?.data.libraryHostFolder) {
      const library = this.getNodeLibraryMapping(node);
      if (library) {
        return { computerRootPath: library.hostAbsolutePath, libraryDeviceRoot: library.devicePath };
      }
      const hostAbsolutePath = this.resolveWorkspaceRelativePath(node.data.libraryHostFolder);
      if (hostAbsolutePath) {
        return { computerRootPath: hostAbsolutePath, libraryDeviceRoot: node.data.libraryDeviceRoot };
      }
    }

    if (this.syncRootPath) {
      return { computerRootPath: this.syncRootPath };
    }
    return undefined;
  }

  private getNodeLibraryMapping(node?: SyncNode): DeviceLibraryMapping | undefined {
    if (!node?.data.deviceId) {
      return undefined;
    }

    const hostFolder = node.data.libraryHostFolder;
    if (hostFolder) {
      return this.getLibraryMappingByHostFolder(node.data.deviceId, hostFolder);
    }

    return this.getLibraryMappingForDevicePath(node.data.deviceId, node.data.relativePath);
  }

  private toNodeScopedComputerRelativePath(node: SyncNode): string {
    const libraryDeviceRoot = node.data.libraryDeviceRoot;
    if (!libraryDeviceRoot) {
      return toRelativePath(node.data.relativePath);
    }
    return this.stripLibraryDeviceRoot(node.data.relativePath, libraryDeviceRoot) ?? toRelativePath(node.data.relativePath);
  }

  private resolveComputerReadRootPath(node?: SyncNode): string | undefined {
    if (node) {
      const scope = this.resolveNodeSyncScope(node);
      if (scope) {
        return scope.computerRootPath;
      }
    }

    if (node?.data.deviceId) {
      return this.syncRootByDeviceId.get(node.data.deviceId) ?? this.syncRootPath;
    }

    if (this.syncRootPath) {
      return this.syncRootPath;
    }

    return this.getHostSyncRootPath();
  }

  private async createComputerFile(node?: SyncNode): Promise<void> {
    const computerRootPath = await this.resolveComputerWriteRootPath();
    if (!computerRootPath) {
      vscode.window.showWarningMessage('Open a workspace before creating files on computer.');
      return;
    }

    const parentPath = this.getComputerParentPath(node);
    const fileName = await vscode.window.showInputBox({
      title: 'Create File on Computer',
      prompt: parentPath ? `Create in /${parentPath}` : 'Create in /',
      placeHolder: 'filename.py',
      ignoreFocusOut: true,
      validateInput: (value) => this.validateComputerName(value)
    });

    if (!fileName) {
      return;
    }

    const relativePath = this.joinDevicePath(parentPath, fileName);
    const absolutePath = path.join(computerRootPath, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, Buffer.alloc(0));
    await this.refresh(false);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(absolutePath));
    await vscode.window.showTextDocument(document, { preview: false });

    const msg = `Created file on computer: /${relativePath}`;
    vscode.window.showInformationMessage(msg);
    logChannelOutput(msg, true);
  }

  private async createComputerFolder(node?: SyncNode): Promise<void> {
    const computerRootPath = await this.resolveComputerWriteRootPath();
    if (!computerRootPath) {
      vscode.window.showWarningMessage('Open a workspace before creating computer folders.');
      return;
    }

    const parentPath = this.getComputerParentPath(node);
    const folderName = await vscode.window.showInputBox({
      title: 'Create Folder on Computer',
      prompt: parentPath ? `Create in /${parentPath}` : 'Create in /',
      placeHolder: 'folder',
      ignoreFocusOut: true,
      validateInput: (value) => this.validateComputerName(value)
    });

    if (!folderName) {
      return;
    }

    const relativePath = this.joinDevicePath(parentPath, folderName);
    const absolutePath = path.join(computerRootPath, relativePath);
    await fs.mkdir(absolutePath, { recursive: true });
    await this.refresh(false);

    const msg = `Created folder on computer: /${relativePath}`;
    vscode.window.showInformationMessage(msg);
    logChannelOutput(msg, true);
  }

  private async renameComputerPath(node: SyncNode): Promise<void> {
    const computerRootPath = this.resolveComputerReadRootPath(node);
    if (!computerRootPath) {
      vscode.window.showWarningMessage('Open a workspace before renaming computer items.');
      return;
    }

    const currentPath = toRelativePath(node.data.relativePath);
    const currentName = path.posix.basename(currentPath);
    const parentPath = path.posix.dirname(currentPath) === '.' ? '' : path.posix.dirname(currentPath);
    const nextName = await vscode.window.showInputBox({
      title: `Rename Computer ${node.data.isDirectory ? 'Folder' : 'File'}`,
      prompt: `Current: /${currentPath}`,
      value: currentName,
      ignoreFocusOut: true,
      validateInput: (value) => this.validateComputerName(value)
    });

    if (!nextName || nextName === currentName) {
      return;
    }

    const nextPath = this.joinDevicePath(parentPath, nextName);
    await fs.rename(path.join(computerRootPath, currentPath), path.join(computerRootPath, nextPath));
    await this.refresh(false);

    const msg = `Renamed computer path: /${currentPath} -> /${nextPath}`;
    vscode.window.showInformationMessage(msg);
    logChannelOutput(msg, true);
  }

  private async deleteComputerPath(node: SyncNode): Promise<void> {
    const computerRootPath = this.resolveComputerReadRootPath(node);
    if (!computerRootPath) {
      vscode.window.showWarningMessage('Open a workspace before deleting computer items.');
      return;
    }

    const targetPath = toRelativePath(node.data.relativePath);
    const action = await vscode.window.showWarningMessage(
      `Delete computer ${node.data.isDirectory ? 'folder' : 'file'} "/${targetPath}"?`,
      { modal: true },
      'Delete'
    );
    if (action !== 'Delete') {
      return;
    }

    await fs.rm(path.join(computerRootPath, targetPath), { recursive: true, force: true });
    await this.refresh(false);

    const msg = `Deleted computer path: /${targetPath}`;
    vscode.window.showInformationMessage(msg);
    logChannelOutput(msg, true);
  }

  getNodeChildren(
    side: NodeSide,
    parentRelativePath: string,
    deviceId?: string,
    libraryContext?: { hostRelativePath: string; devicePath: string; missing: boolean }
  ): SyncNode[] {
    this.activateDevice(deviceId ?? this.activeDeviceId);
    const sourceEntries = side === 'device'
      ? this.deviceEntries
      : (deviceId ? this.computerEntries : this.unmappedHostEntries);
    const nodes: SyncNode[] = [];
    const normalisedParentPath = toRelativePath(parentRelativePath);

    for (const entry of sourceEntries) {
      if (entry.relativePath.length === 0) {
        continue;
      }

      const parent = path.posix.dirname(entry.relativePath);
      const directParent = parent === '.' ? '' : toRelativePath(parent);
      if (directParent !== normalisedParentPath) {
        continue;
      }

      const name = path.posix.basename(entry.relativePath);
      nodes.push(
        new SyncNode(
          {
            side,
            relativePath: entry.relativePath,
            isDirectory: entry.isDirectory,
            deviceId,
            libraryHostFolder: libraryContext?.hostRelativePath,
            libraryDeviceRoot: libraryContext?.devicePath,
            isLibraryMissing: libraryContext?.missing
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
    return getConnectedPyDevices().length > 0;
  }

  getSyncRootPath(): string | undefined {
    return this.syncRootPath;
  }

  getActiveDeviceId(): string | undefined {
    return this.activeDeviceId;
  }

  isExplorerReady(): boolean {
    return this.explorerReady;
  }

  hasWorkspaceFolder(): boolean {
    return !!this.workspaceFolder;
  }

  hasConfigurationFolder(): boolean {
    return this.hasConfigurationFile;
  }

  hasWorkspaceSyncFolder(): boolean {
    return true;
  }

  getKnownDeviceIds(): string[] {
    return [...this.knownDeviceIds].sort((a, b) => a.localeCompare(b));
  }

  getMappedHostDeviceIds(): string[] {
    return Object.keys(this.deviceHostFolderMappings).sort((a, b) => a.localeCompare(b));
  }

  getMappedHostFolderCount(): number {
    return new Set(
      Object.values(this.deviceHostFolderMappings)
        .map((item) => toRelativePath(item))
        .filter((item) => item.length > 0)
    ).size;
  }

  getAvailableHostFolderCount(): number {
    return this.mappableHostFolders.length;
  }

  getAvailableHostFolders(): string[] {
    return [...this.mappableHostFolders];
  }

  getConnectedDeviceIds(): string[] {
    return getConnectedPyDevices().map((item) => item.deviceId).sort((a, b) => a.localeCompare(b));
  }

  getConnectedDevice(deviceId: string): ReturnType<typeof getConnectedPyDevices>[number] | undefined {
    return getConnectedPyDevices().find((item) => item.deviceId === deviceId);
  }

  getMappedHostFolder(deviceId: string): string | undefined {
    return this.deviceHostFolderMappings[deviceId];
  }

  getDeviceLibraryMappings(deviceId: string): DeviceLibraryMapping[] {
    return [...(this.librariesByDeviceId.get(deviceId) ?? [])];
  }

  private getLibraryMappingByHostFolder(deviceId: string, hostRelativePath: string): DeviceLibraryMapping | undefined {
    const target = toRelativePath(hostRelativePath);
    if (!target) {
      return undefined;
    }
    return this.getDeviceLibraryMappings(deviceId).find((item) => item.hostRelativePath === target);
  }

  private getLibraryMappingForDevicePath(deviceId: string, relativePath: string): DeviceLibraryMapping | undefined {
    const target = toRelativePath(relativePath);
    if (!target) {
      return undefined;
    }
    const mappings = this.getDeviceLibraryMappings(deviceId)
      .filter((item) => target === item.devicePath || target.startsWith(`${item.devicePath}/`))
      .sort((a, b) => b.devicePath.length - a.devicePath.length);
    return mappings[0];
  }

  private stripLibraryDeviceRoot(relativePath: string, libraryDeviceRoot: string): string | undefined {
    const target = toRelativePath(relativePath);
    const root = toRelativePath(libraryDeviceRoot);
    if (!root) {
      return target;
    }
    if (!target) {
      return '';
    }
    if (target === root) {
      return '';
    }
    if (target.startsWith(`${root}/`)) {
      return target.slice(root.length + 1);
    }
    return undefined;
  }

  private applyLibraryDeviceRoot(relativePath: string, libraryDeviceRoot: string): string {
    const target = toRelativePath(relativePath);
    const root = toRelativePath(libraryDeviceRoot);
    if (!root) {
      return target;
    }
    if (!target) {
      return root;
    }
    return toRelativePath(path.posix.join(root, target));
  }

  getDeviceName(deviceId: string): string | undefined {
    const name = this.deviceNames[deviceId];
    if (!name) {
      return undefined;
    }
    const trimmed = name.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  getDeviceDisplayName(deviceId: string): string {
    return this.getDeviceName(deviceId) ?? deviceId;
  }

  getDeviceDisplayNameWithId(deviceId: string): string {
    const name = this.getDeviceName(deviceId);
    return name ? `${name} (${deviceId})` : deviceId;
  }

  getDeviceUriSegment(deviceId: string): string {
    return this.getDeviceName(deviceId) ?? deviceId;
  }

  private async syncNameHistory(): Promise<void> {
    const nextHistory: Record<string, string> = { ...this.nameHistoryByLower };
    let changed = false;
    for (const [deviceId, nameRaw] of Object.entries(this.deviceNames)) {
      const name = nameRaw.trim();
      if (!name) {
        continue;
      }
      const key = name.toLocaleLowerCase();
      if (nextHistory[key] === deviceId) {
        continue;
      }
      nextHistory[key] = deviceId;
      changed = true;
    }

    if (!changed) {
      return;
    }

    this.nameHistoryByLower = nextHistory;
    await this.context.globalState.update(nameHistoryStateKey, nextHistory);
  }

  resolveDeviceIdFromUriSegment(segment: string): string | undefined {
    const decoded = segment.trim();
    if (!decoded) {
      return undefined;
    }

    if (this.knownDeviceIds.has(decoded) || getConnectedPyDevices().some((item) => item.deviceId === decoded)) {
      return decoded;
    }

    const needle = decoded.toLocaleLowerCase();
    for (const [deviceId, name] of Object.entries(this.deviceNames)) {
      if (name.trim().toLocaleLowerCase() === needle) {
        return deviceId;
      }
    }

    const historicalDeviceId = this.nameHistoryByLower[needle];
    if (historicalDeviceId) {
      return historicalDeviceId;
    }

    return undefined;
  }

  private validateNameConfigurationAndWarn(): void {
    const nameBuckets = new Map<string, { name: string; deviceIds: string[] }>();
    for (const [deviceId, nameRaw] of Object.entries(this.deviceNames)) {
      const name = nameRaw.trim();
      if (!name) {
        continue;
      }
      const key = name.toLocaleLowerCase();
      const existing = nameBuckets.get(key);
      if (existing) {
        existing.deviceIds.push(deviceId);
      } else {
        nameBuckets.set(key, { name, deviceIds: [deviceId] });
      }
    }

    const duplicates = [...nameBuckets.values()]
      .filter((item) => item.deviceIds.length > 1)
      .sort((a, b) => a.name.localeCompare(b.name));
    if (duplicates.length === 0) {
      this.duplicateNameWarningKey = undefined;
      return;
    }

    const warningKey = duplicates
      .map((item) => `${item.name}:${[...item.deviceIds].sort((a, b) => a.localeCompare(b)).join(',')}`)
      .join('|');
    if (this.duplicateNameWarningKey === warningKey) {
      return;
    }
    this.duplicateNameWarningKey = warningKey;

    const details = duplicates
      .map((item) => `${item.name} (${item.deviceIds.join(', ')})`)
      .join('; ');
    const message = `Duplicate device names found in configuration: ${details}. Names must be unique.`;
    vscode.window.showErrorMessage(message);
    logChannelOutput(message, true);
  }

  private computeNameSyncKey(): string {
    return Object.entries(this.deviceNames)
      .map(([deviceId, name]) => `${deviceId}:${name.trim().toLocaleLowerCase()}`)
      .sort((a, b) => a.localeCompare(b))
      .join('|');
  }

  private decodeUriSegment(segment: string): string {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  }

  private remapDeviceUriSegment(
    uri: vscode.Uri,
    acceptedSegments: ReadonlySet<string>,
    nextSegment: string,
    resolvedDeviceId?: string
  ): vscode.Uri | undefined {
    if (uri.scheme !== deviceDocumentScheme) {
      return undefined;
    }

    const rawPath = uri.path.replace(/^\/+/, '');
    const segments = rawPath.split('/').filter((item) => item.length > 0);
    if (segments.length < 2) {
      return undefined;
    }

    const currentSegment = this.decodeUriSegment(segments[0]);
    if (!acceptedSegments.has(currentSegment)) {
      return undefined;
    }

    segments[0] = nextSegment;
    const queryParams = new URLSearchParams(uri.query);
    if (resolvedDeviceId && resolvedDeviceId.trim().length > 0) {
      queryParams.set('deviceId', resolvedDeviceId);
    }
    return uri.with({ path: `/${segments.join('/')}`, query: queryParams.toString() });
  }

  private async remapOpenDeviceTabsForNameChange(
    deviceId: string,
    previousSegment: string,
    nextSegment: string
  ): Promise<void> {
    if (previousSegment === nextSegment) {
      return;
    }

    const acceptedSegments = new Set<string>([deviceId, previousSegment]);
    const matchingTabs: Array<{
      oldUri: vscode.Uri;
      newUri: vscode.Uri;
      viewColumn: vscode.ViewColumn;
      isPreview: boolean;
    }> = [];

    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (!(tab.input instanceof vscode.TabInputText)) {
          continue;
        }
        const newUri = this.remapDeviceUriSegment(tab.input.uri, acceptedSegments, nextSegment, deviceId);
        if (!newUri) {
          continue;
        }
        matchingTabs.push({
          oldUri: tab.input.uri,
          newUri,
          viewColumn: group.viewColumn,
          isPreview: (tab as vscode.Tab & { isPreview?: boolean }).isPreview ?? false
        });
      }
    }

    if (matchingTabs.length === 0) {
      return;
    }

    const oldUriKeysToClose = new Set<string>();
    let skippedDirtyCount = 0;

    for (const entry of matchingTabs) {
      const isDirty = vscode.workspace.textDocuments.some(
        (document) => document.uri.toString() === entry.oldUri.toString() && document.isDirty
      );
      if (isDirty) {
        skippedDirtyCount += 1;
        continue;
      }

      try {
        const document = await vscode.workspace.openTextDocument(entry.newUri);
        await vscode.window.showTextDocument(document, {
          viewColumn: entry.viewColumn,
          preserveFocus: true,
          preview: entry.isPreview
        });
        oldUriKeysToClose.add(entry.oldUri.toString());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logChannelOutput(`Unable to retitle device tab ${entry.oldUri.toString()}: ${message}`, true);
      }
    }

    if (oldUriKeysToClose.size > 0) {
      const tabsToClose: vscode.Tab[] = [];
      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          if (!(tab.input instanceof vscode.TabInputText)) {
            continue;
          }
          if (oldUriKeysToClose.has(tab.input.uri.toString())) {
            tabsToClose.push(tab);
          }
        }
      }
      if (tabsToClose.length > 0) {
        await vscode.window.tabGroups.close(tabsToClose, true);
      }
    }

    if (skippedDirtyCount > 0) {
      vscode.window.showWarningMessage(
        `Name updated, but ${skippedDirtyCount} dirty tab(s) were not retitled to avoid losing unsaved changes. Save/reopen those tabs to apply the new name title.`
      );
    }
  }

  private async normalizeOpenDeviceTabsToCurrentNameSegments(): Promise<void> {
    const matchingTabs: Array<{
      oldUri: vscode.Uri;
      newUri: vscode.Uri;
      viewColumn: vscode.ViewColumn;
      isPreview: boolean;
    }> = [];

    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (!(tab.input instanceof vscode.TabInputText)) {
          continue;
        }

        const uri = tab.input.uri;
        if (uri.scheme !== deviceDocumentScheme) {
          continue;
        }

        const rawPath = uri.path.replace(/^\/+/, '');
        const segments = rawPath.split('/').filter((item) => item.length > 0);
        if (segments.length < 2) {
          continue;
        }

        const currentSegment = this.decodeUriSegment(segments[0]);
        const resolvedDeviceId = this.resolveDeviceIdFromUriSegment(currentSegment);
        const canonicalSegment = resolvedDeviceId ? this.getDeviceUriSegment(resolvedDeviceId) : currentSegment;
        const queryParams = new URLSearchParams(uri.query);
        const queryDeviceId = queryParams.get('deviceId')?.trim();
        const needsPathUpdate = canonicalSegment !== currentSegment;
        const needsQueryUpdate = !!resolvedDeviceId && queryDeviceId !== resolvedDeviceId;
        if (!needsPathUpdate && !needsQueryUpdate) {
          continue;
        }

        segments[0] = canonicalSegment;
        if (resolvedDeviceId) {
          queryParams.set('deviceId', resolvedDeviceId);
        }
        const newUri = uri.with({ path: `/${segments.join('/')}`, query: queryParams.toString() });
        matchingTabs.push({
          oldUri: uri,
          newUri,
          viewColumn: group.viewColumn,
          isPreview: (tab as vscode.Tab & { isPreview?: boolean }).isPreview ?? false
        });
      }
    }

    if (matchingTabs.length === 0) {
      return;
    }

    const oldUriKeysToClose = new Set<string>();
    let skippedDirtyCount = 0;

    for (const entry of matchingTabs) {
      const isDirty = vscode.workspace.textDocuments.some(
        (document) => document.uri.toString() === entry.oldUri.toString() && document.isDirty
      );
      if (isDirty) {
        skippedDirtyCount += 1;
        continue;
      }

      try {
        const document = await vscode.workspace.openTextDocument(entry.newUri);
        await vscode.window.showTextDocument(document, {
          viewColumn: entry.viewColumn,
          preserveFocus: true,
          preview: entry.isPreview
        });
        oldUriKeysToClose.add(entry.oldUri.toString());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logChannelOutput(`Unable to normalize device tab ${entry.oldUri.toString()}: ${message}`, true);
      }
    }

    if (oldUriKeysToClose.size > 0) {
      const tabsToClose: vscode.Tab[] = [];
      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          if (!(tab.input instanceof vscode.TabInputText)) {
            continue;
          }
          if (oldUriKeysToClose.has(tab.input.uri.toString())) {
            tabsToClose.push(tab);
          }
        }
      }
      if (tabsToClose.length > 0) {
        await vscode.window.tabGroups.close(tabsToClose, true);
      }
    }

    if (skippedDirtyCount > 0) {
      vscode.window.showWarningMessage(
        `Name configuration changed, but ${skippedDirtyCount} dirty tab(s) were not retitled to avoid losing unsaved changes. Save/reopen those tabs to apply name titles.`
      );
    }
  }

  async mapDeviceToHostFolder(node?: SyncNode): Promise<void> {
    let deviceId = await this.ensureActiveDevice(node);
    if (!deviceId) {
      deviceId = await this.pickKnownDeviceId('Select device to map');
      if (deviceId) {
        this.activateDevice(deviceId);
      }
    }
    if (!deviceId || !this.workspaceFolder) {
      vscode.window.showWarningMessage('Select a device to map.');
      return;
    }

    const folderOptions = this.mappableHostFolders.map((folder) => {
      const leafName = path.posix.basename(toRelativePath(folder));
      return {
        label: leafName,
        description: folder,
        relativePath: folder
      };
    });

    if (folderOptions.length === 0) {
      vscode.window.showWarningMessage('No computer folders available at workspace root.');
      return;
    }

    const picked = await vscode.window.showQuickPick(folderOptions, {
      title: 'Map Device to Computer Folder',
      placeHolder: `Select computer folder for ${deviceId}`,
      canPickMany: false,
      ignoreFocusOut: true
    });
    if (!picked) {
      return;
    }

    const normalised = picked.relativePath;

    const updated = await updateDeviceHostFolderMapping(deviceId, normalised);
    this.deviceHostFolderMappings = getDeviceHostFolderMappings(updated);

    const msg = `Mapped ${deviceId} to computer folder: ${normalised}`;
    logChannelOutput(msg, true);
    vscode.window.showInformationMessage(msg);
    await this.refresh(true);
  }

  async unmapDeviceFromHostFolder(node?: SyncNode): Promise<void> {
    let deviceId = await this.ensureActiveDevice(node);
    if (!deviceId) {
      deviceId = await this.pickKnownDeviceId('Select device to unmap');
      if (deviceId) {
        this.activateDevice(deviceId);
      }
    }
    if (!deviceId) {
      vscode.window.showWarningMessage('Select a device to unmap.');
      return;
    }

    const current = this.getMappedHostFolder(deviceId);
    if (!current) {
      vscode.window.showInformationMessage(`No mapped computer folder exists for ${deviceId}.`);
      return;
    }

    const action = await vscode.window.showWarningMessage(
      `Unmap ${deviceId} from computer folder "${current}"?`,
      { modal: true },
      'Unmap'
    );
    if (action !== 'Unmap') {
      return;
    }

    const updated = await updateDeviceHostFolderMapping(deviceId, undefined);
    this.deviceHostFolderMappings = getDeviceHostFolderMappings(updated);

    const msg = `Unmapped ${deviceId} from computer folder: ${current}`;
    logChannelOutput(msg, true);
    vscode.window.showInformationMessage(msg);
    await this.refresh(true);
  }

  async addDeviceLibraryFolder(node?: SyncNode): Promise<void> {
    let deviceId = await this.ensureActiveDevice(node);
    if (!deviceId) {
      deviceId = await this.pickKnownDeviceId('Select device to add a library for');
      if (deviceId) {
        this.activateDevice(deviceId);
      }
    }
    if (!deviceId || !this.workspaceFolder) {
      vscode.window.showWarningMessage('Select a device and open a workspace to add a library folder.');
      return;
    }

    const picked = await vscode.window.showOpenDialog({
      title: `Select library folder for ${this.getDeviceDisplayNameWithId(deviceId)}`,
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      defaultUri: this.workspaceFolder.uri,
      openLabel: 'Add Library Folder'
    });
    if (!picked || picked.length === 0) {
      return;
    }

    const selectedPath = picked[0].fsPath;
    const workspacePath = this.workspaceFolder.uri.fsPath;
    const relativeToWorkspace = path.relative(workspacePath, selectedPath);
    const normalisedRelativePath = toRelativePath(relativeToWorkspace);
    if (!normalisedRelativePath || path.isAbsolute(normalisedRelativePath) || /^[A-Za-z]:\//.test(normalisedRelativePath)) {
      vscode.window.showWarningMessage('Selected folder must resolve to a relative path from the current workspace.');
      return;
    }

    const existingLibraries = this.deviceLibraryFolderMappings[deviceId] ?? [];
    const nextLibraries = [...new Set([...existingLibraries, normalisedRelativePath])].sort((a, b) => a.localeCompare(b));
    const updated = await updateDeviceLibraryFolders(deviceId, nextLibraries);
    this.deviceLibraryFolderMappings = getDeviceLibraryFolderMappings(updated);

    const deviceLibraryName = path.posix.basename(normalisedRelativePath);
    const msg = `Added library for ${deviceId}: ${normalisedRelativePath} -> /${deviceLibraryName}`;
    logChannelOutput(msg, true);
    vscode.window.showInformationMessage(msg);
    await this.refresh(true);
  }

  async removeDeviceLibraryFolder(node?: SyncNode): Promise<void> {
    let deviceId = await this.ensureActiveDevice(node);
    if (!deviceId) {
      deviceId = await this.pickKnownDeviceId('Select device to remove a library from');
      if (deviceId) {
        this.activateDevice(deviceId);
      }
    }
    if (!deviceId) {
      vscode.window.showWarningMessage('Select a device to remove a library folder.');
      return;
    }

    const existingLibraries = this.deviceLibraryFolderMappings[deviceId] ?? [];
    if (existingLibraries.length === 0) {
      vscode.window.showInformationMessage(`No library folders configured for ${deviceId}.`);
      return;
    }

    const selectedLibrary = node?.data.libraryHostFolder
      ? toRelativePath(node.data.libraryHostFolder)
      : undefined;
    let libraryToRemove = selectedLibrary;
    if (!libraryToRemove) {
      const picked = await vscode.window.showQuickPick(
        existingLibraries.map((libraryPath) => ({
          label: path.posix.basename(libraryPath),
          description: libraryPath,
          libraryPath
        })),
        {
          title: 'Remove Device Library Folder',
          placeHolder: `Select library folder to remove for ${this.getDeviceDisplayNameWithId(deviceId)}`,
          canPickMany: false,
          ignoreFocusOut: true
        }
      );
      if (!picked) {
        return;
      }
      libraryToRemove = picked.libraryPath;
    }

    if (!libraryToRemove) {
      return;
    }

    const action = await vscode.window.showWarningMessage(
      `Remove library folder "${libraryToRemove}" from ${this.getDeviceDisplayNameWithId(deviceId)}?`,
      { modal: true },
      'Remove'
    );
    if (action !== 'Remove') {
      return;
    }

    const nextLibraries = existingLibraries.filter((item) => item !== libraryToRemove);
    const updated = await updateDeviceLibraryFolders(deviceId, nextLibraries);
    this.deviceLibraryFolderMappings = getDeviceLibraryFolderMappings(updated);

    const msg = `Removed library for ${deviceId}: ${libraryToRemove}`;
    logChannelOutput(msg, true);
    vscode.window.showInformationMessage(msg);
    await this.refresh(true);
  }

  async setDeviceName(node?: SyncNode): Promise<void> {
    let deviceId = await this.ensureActiveDevice(node);
    if (!deviceId) {
      deviceId = await this.pickKnownDeviceId('Select device to set name');
      if (deviceId) {
        this.activateDevice(deviceId);
      }
    }
    if (!deviceId) {
      vscode.window.showWarningMessage('Select a device to set a name.');
      return;
    }

    const existingName = this.getDeviceName(deviceId) ?? '';
    const input = await vscode.window.showInputBox({
      title: 'Set Device Name',
      prompt: `Set a friendly name for ${this.getDeviceDisplayNameWithId(deviceId)}. Leave empty to clear.`,
      value: existingName,
      ignoreFocusOut: true,
      validateInput: (value) => {
        const trimmed = value.trim();
        if (trimmed.length > 64) {
          return 'Name must be 64 characters or fewer.';
        }
        if (trimmed.length > 0) {
          const needle = trimmed.toLocaleLowerCase();
          const duplicate = Object.entries(this.deviceNames).find(([existingDeviceId, existingDeviceName]) => {
            if (existingDeviceId === deviceId) {
              return false;
            }
            return existingDeviceName.trim().toLocaleLowerCase() === needle;
          });
          if (duplicate) {
            return `Name "${trimmed}" is already used by ${duplicate[0]}. Names must be unique.`;
          }
        }
        return undefined;
      }
    });
    if (input === undefined) {
      return;
    }

    const name = input.trim();
    const previousUriSegment = existingName.length > 0 ? existingName : deviceId;
    if (name.length > 0) {
      const needle = name.toLocaleLowerCase();
      const duplicate = Object.entries(this.deviceNames).find(([existingDeviceId, existingDeviceName]) => {
        if (existingDeviceId === deviceId) {
          return false;
        }
        return existingDeviceName.trim().toLocaleLowerCase() === needle;
      });
      if (duplicate) {
        vscode.window.showErrorMessage(`Name "${name}" is already used by ${duplicate[0]}.`);
        return;
      }
    }
    let updated;
    try {
      updated = await updateDeviceName(deviceId, name.length > 0 ? name : undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(message);
      return;
    }
    this.deviceNames = getDeviceNames(updated);
    this.validateNameConfigurationAndWarn();
    await this.remapOpenDeviceTabsForNameChange(deviceId, previousUriSegment, this.getDeviceUriSegment(deviceId));

    const msg = name.length > 0
      ? `Set name for ${deviceId}: ${name}`
      : `Cleared name for ${deviceId}`;
    logChannelOutput(msg, true);
    vscode.window.showInformationMessage(msg);
    await this.refresh(true);
  }

  async closeDeviceConnection(node?: SyncNode): Promise<void> {
    const deviceId = this.getNodeDeviceId(node);
    if (!deviceId) {
      vscode.window.showWarningMessage('Select a connected device to disconnect.');
      return;
    }

    await vscode.commands.executeCommand('mekatrol.pydevice.disconnectboard', { deviceId });
  }

  async closeAllDeviceConnections(): Promise<void> {
    const connected = this.getConnectedDeviceIds();
    if (connected.length === 0) {
      vscode.window.showInformationMessage('No active board connections to disconnect.');
      return;
    }

    const action = await vscode.window.showWarningMessage(
      `Disconnect all ${connected.length} active board connection(s)?`,
      { modal: true },
      'Disconnect All'
    );
    if (action !== 'Disconnect All') {
      return;
    }

    const closed = await closeAllConnectedPyDevices(
      false,
      false,
      true,
      true
    );
    if (closed) {
      await this.refresh(false);
      vscode.window.showInformationMessage(`Disconnected ${connected.length} board connection(s).`);
    }
  }

  setSelectedDeviceNode(node: SyncNode | undefined): void {
    this.selectedNode = node;
    void this.ensureActiveDevice(node);
  }

  private getDeviceParentPath(node?: SyncNode): string {
    if (!node || node.data.side !== 'device') {
      return '';
    }

    if (node.data.isDirectory) {
      return toRelativePath(node.data.relativePath);
    }

    const parent = path.posix.dirname(node.data.relativePath);
    return parent === '.' ? '' : toRelativePath(parent);
  }

  private getDeviceCreateParentPath(node?: SyncNode): string {
    const target = node?.data.side === 'device'
      ? node
      : (this.selectedNode?.data.side === 'device' ? this.selectedNode : undefined);
    if (!target) {
      return '';
    }

    // Device-id/root nodes are virtual containers representing the device root.
    if (target.data.isDeviceIdNode || target.data.isRoot) {
      return '';
    }

    return this.getDeviceParentPath(target);
  }

  private joinDevicePath(parentPath: string, name: string): string {
    const trimmedName = name.trim();
    if (!parentPath) {
      return toRelativePath(trimmedName);
    }
    return toRelativePath(path.posix.join(parentPath, trimmedName));
  }

  private validateDeviceName(value: string): string | undefined {
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

  private toSyncRelativePath(fsPath: string): string | undefined {
    if (!this.syncRootPath) {
      return undefined;
    }

    const normalised = toRelativePath(path.relative(this.syncRootPath, fsPath));
    if (normalised.startsWith('..')) {
      return undefined;
    }

    return normalised;
  }

  async handleDocumentSaved(document: vscode.TextDocument): Promise<void> {
    if (document.uri.scheme === deviceDocumentScheme) {
      await this.refresh(true);
      return;
    }

    if (document.uri.scheme === 'file') {
      const relativePath = this.toSyncRelativePath(document.uri.fsPath);
      if (!relativePath) {
        return;
      }

      await this.refresh(false);
    }
  }

  async handlePossibleSyncFileChange(fsPath: string): Promise<void> {
    if (!this.toSyncRelativePath(fsPath)) {
      return;
    }

    await this.refresh(false);
  }

  private async openDeviceDiff(node: SyncNode): Promise<void> {
    const deviceId = await this.ensureActiveDevice(node);
    if (!deviceId || !getConnectedPyDevice(deviceId)) {
      vscode.window.showWarningMessage('Connect to a board before comparing a device file.');
      return;
    }

    if (!this.syncRootPath) {
      await this.refresh(false);
    }

    const computerRootPath = this.resolveComputerReadRootPath(node);
    if (!computerRootPath || node.data.isDirectory || node.data.isRoot || node.data.isIndicator) {
      return;
    }

    const compareAvailability = this.getDeviceFileCompareAvailability(node.data);
    if (compareAvailability === 'unmapped') {
      vscode.window.showWarningMessage('Map this device to a computer folder before comparing files.');
      return;
    }

    const relativePath = this.toNodeScopedComputerRelativePath(node);
    if (compareAvailability === 'hostMissing') {
      vscode.window.showWarningMessage(`The file "${relativePath}" does not exist on the mapped computer folder.`);
      return;
    }

    const computerPath = path.join(computerRootPath, relativePath);
    try {
      const stat = await fs.stat(computerPath);
      if (!stat.isFile()) {
        throw new Error('Not a file');
      }
    } catch {
      vscode.window.showWarningMessage(`No computer sync file exists for "${relativePath}". Sync from device first.`);
      return;
    }

    const computerUri = vscode.Uri.file(computerPath);
    const deviceSegment = encodeURIComponent(this.getDeviceUriSegment(deviceId));
    const deviceUri = vscode.Uri.parse(`${deviceDocumentScheme}:/${deviceSegment}/${relativePath}?deviceId=${encodeURIComponent(deviceId)}`);
    const title = `${relativePath} (Computer <-> Device)`;
    await vscode.commands.executeCommand('vscode.diff', computerUri, deviceUri, title, { preview: false });
  }

  private async buildDeviceFileCompareRows(
    deviceId: string,
    board: NonNullable<ReturnType<typeof getConnectedPyDevice>>,
    targetRelativePath: string = ''
  ): Promise<DeviceFileCompareRow[]> {
    const scopedTarget = toRelativePath(targetRelativePath);
    const isInTarget = (relativePath: string): boolean =>
      this.matchesTarget(toRelativePath(relativePath), scopedTarget, true);
    const intersectsTarget = (relativePath: string): boolean =>
      this.matchesTarget(toRelativePath(relativePath), scopedTarget, true)
      || this.matchesTarget(scopedTarget, toRelativePath(relativePath), true);

    const syncableDeviceEntries = this.filterSyncableEntries(await listDeviceEntries(board))
      .filter((entry) => !entry.isDirectory && toRelativePath(entry.relativePath).length > 0)
      .filter((entry) => isInTarget(entry.relativePath));
    const syncRootPath = this.syncRootByDeviceId.get(deviceId);
    const libraries = this.getDeviceLibraryMappings(deviceId);
    const libraryRoots = new Set(
      libraries
        .map((library) => toRelativePath(library.devicePath))
        .filter((root) => root.length > 0)
    );
    const deviceEntriesByLibrary = new Map<string, FileEntry[]>();
    const rootDeviceEntries: FileEntry[] = [];

    for (const entry of syncableDeviceEntries) {
      const deviceRelativePath = toRelativePath(entry.relativePath);
      const matchingLibrary = this.getLibraryMappingForDevicePath(deviceId, deviceRelativePath);
      if (!matchingLibrary) {
        rootDeviceEntries.push(entry);
        continue;
      }
      const key = `${matchingLibrary.hostRelativePath}::${matchingLibrary.devicePath}`;
      const current = deviceEntriesByLibrary.get(key) ?? [];
      current.push(entry);
      deviceEntriesByLibrary.set(key, current);
    }

    const rows: DeviceFileCompareRow[] = [];
    const addRow = (row: Omit<DeviceFileCompareRow, 'id'>): void => {
      const id = `${row.deviceRelativePath}:${row.status}:${row.libraryHostFolder ?? ''}:${row.libraryDeviceRoot ?? ''}`;
      rows.push({ ...row, id });
    };
    const toStatus = (deviceFile?: FileEntry, computerFile?: FileEntry): DeviceFileCompareStatus => {
      if (deviceFile && computerFile) {
        const shaMatches = !!deviceFile.sha1 && !!computerFile.sha1 && deviceFile.sha1 === computerFile.sha1;
        if (shaMatches) {
          return 'match';
        }
        const sizeMatches = !deviceFile.sha1
          && deviceFile.size !== undefined
          && computerFile.size !== undefined
          && deviceFile.size === computerFile.size;
        return sizeMatches ? 'match' : 'mismatch';
      }
      return deviceFile ? 'missing_computer' : 'missing_device';
    };

    const rootComputerFiles = syncRootPath
      ? this.filterSyncableEntries(await scanComputerSyncEntries(syncRootPath))
        .filter((entry) => !entry.isDirectory)
        .filter((entry) => isInTarget(entry.relativePath))
        .filter((entry) => !this.isWithinLibraryRoots(toRelativePath(entry.relativePath), libraryRoots))
      : [];
    const rootDeviceMap = new Map(rootDeviceEntries.map((entry) => [toRelativePath(entry.relativePath), entry]));
    const rootComputerMap = new Map(rootComputerFiles.map((entry) => [toRelativePath(entry.relativePath), entry]));
    const rootPaths = new Set<string>([...rootDeviceMap.keys(), ...rootComputerMap.keys()]);
    for (const relativePath of rootPaths) {
      const deviceFile = rootDeviceMap.get(relativePath);
      const computerFile = rootComputerMap.get(relativePath);
      addRow({
        deviceRelativePath: relativePath,
        status: toStatus(deviceFile, computerFile),
        scopeLabel: syncRootPath ? this.getMappedHostFolder(deviceId) ?? 'mapped folder' : 'not mapped',
        scopeIcon: 'folder'
      });
    }

    for (const library of libraries) {
      const key = `${library.hostRelativePath}::${library.devicePath}`;
      const libraryDeviceRoot = toRelativePath(library.devicePath);
      if (!libraryDeviceRoot) {
        continue;
      }
      if (!intersectsTarget(libraryDeviceRoot)) {
        continue;
      }
      const scopedDeviceEntries = deviceEntriesByLibrary.get(key) ?? [];
      const scopedDeviceMap = new Map<string, FileEntry>();
      for (const entry of scopedDeviceEntries) {
        const scopedPath = this.stripLibraryDeviceRoot(entry.relativePath, libraryDeviceRoot);
        if (!scopedPath) {
          continue;
        }
        scopedDeviceMap.set(scopedPath, entry);
      }

      if (library.missing) {
        for (const scopedPath of scopedDeviceMap.keys()) {
          addRow({
            deviceRelativePath: this.applyLibraryDeviceRoot(scopedPath, libraryDeviceRoot),
            status: 'missing_computer',
            libraryHostFolder: library.hostRelativePath,
            libraryDeviceRoot: library.devicePath,
            scopeLabel: `${library.hostRelativePath} (missing)`,
            scopeIcon: 'library'
          });
        }
        continue;
      }

      const scopedComputerFiles = this.filterSyncableEntries(await scanComputerSyncEntries(library.hostAbsolutePath))
        .filter((entry) => !entry.isDirectory)
        .filter((entry) => isInTarget(this.applyLibraryDeviceRoot(entry.relativePath, libraryDeviceRoot)));
      const scopedComputerMap = new Map(scopedComputerFiles.map((entry) => [toRelativePath(entry.relativePath), entry]));
      const scopedPaths = new Set<string>([...scopedDeviceMap.keys(), ...scopedComputerMap.keys()]);
      for (const scopedPath of scopedPaths) {
        const deviceFile = scopedDeviceMap.get(scopedPath);
        const computerFile = scopedComputerMap.get(scopedPath);
        addRow({
          deviceRelativePath: this.applyLibraryDeviceRoot(scopedPath, libraryDeviceRoot),
          status: toStatus(deviceFile, computerFile),
          libraryHostFolder: library.hostRelativePath,
          libraryDeviceRoot: library.devicePath,
          scopeLabel: library.hostRelativePath,
          scopeIcon: 'library'
        });
      }
    }

    return rows.sort((a, b) => a.deviceRelativePath.localeCompare(b.deviceRelativePath));
  }

  private renderDeviceFileCompareHtml(deviceId: string, rows: DeviceFileCompareRow[], hasDifferences: boolean): string {
    const titleText = this.escapeHtml(`Compare files for ${this.getDeviceDisplayNameWithId(deviceId)}`);
    const rowsJson = JSON.stringify(rows);
    return `<!DOCTYPE html>
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
    th, td { padding: 8px 10px; border-bottom: 1px solid var(--vscode-editorWidget-border); vertical-align: middle; user-select: text; }
    th { text-align: left; font-weight: 600; }
    th.status, td.status { width: 180px; }
    th.scope, td.scope { width: 220px; }
    th.action, td.action { width: 90px; text-align: center; }
    td.path { font-family: var(--vscode-editor-font-family); font-size: 12px; }
    td.scope { color: var(--vscode-descriptionForeground); font-size: 12px; }
    .scope-wrap { display: inline-flex; align-items: center; gap: 6px; }
    .scope-icon { width: 14px; height: 14px; color: var(--vscode-descriptionForeground); display: inline-flex; align-items: center; justify-content: center; }
    .scope-icon svg { width: 14px; height: 14px; fill: currentColor; }
    .status-wrap { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
    .icon { width: 14px; height: 14px; display: inline-flex; align-items: center; justify-content: center; }
    .icon svg { width: 14px; height: 14px; fill: currentColor; }
    .status-match { color: var(--vscode-charts-green); }
    .status-mismatch { color: var(--vscode-charts-yellow); }
    .status-missing_computer, .status-missing_device { color: var(--vscode-descriptionForeground); }
    .empty { padding: 20px; text-align: center; color: var(--vscode-descriptionForeground); }
    .link {
      color: var(--vscode-textLink-foreground);
      text-decoration: underline;
      background: none;
      border: none;
      padding: 0;
      cursor: pointer;
      font: inherit;
    }
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
  </style>
</head>
<body>
  <div class="wrap">
    <h2>${titleText}</h2>
    <p class="hint">Use Compare on mismatched files to open a side-by-side diff in a new tab.</p>
    <table>
      <thead>
        <tr>
          <th>Path</th>
          <th class="scope">Scope</th>
          <th class="status">Status</th>
          <th class="action">Action</th>
        </tr>
      </thead>
      <tbody id="rows"></tbody>
    </table>
    <div class="buttons">
      ${hasDifferences ? '<button id="syncToDevice" class="secondary">Sync Computer to Device</button>' : ''}
      ${hasDifferences ? '<button id="syncFromDevice" class="secondary">Sync Device to Computer</button>' : ''}
      <button id="close">Close</button>
    </div>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const rows = ${rowsJson};
    const tbody = document.getElementById('rows');
    const labels = {
      match: {
        text: 'Files match',
        iconSvg: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.6484 5.64648C10.8434 5.45148 11.1605 5.45148 11.3555 5.64648C11.5498 5.84137 11.5499 6.15766 11.3555 6.35254L7.35547 10.3525C7.25747 10.4495 7.12898 10.499 7.00098 10.499C6.87299 10.499 6.74545 10.4505 6.64746 10.3525L4.64746 8.35254C4.45247 8.15754 4.45248 7.84148 4.64746 7.64648C4.84246 7.45148 5.15949 7.45148 5.35449 7.64648L7 9.29199L10.6465 5.64648H10.6484Z"></path><path fill-rule="evenodd" clip-rule="evenodd" d="M8 1C11.86 1 15 4.14 15 8C15 11.86 11.86 15 8 15C4.14 15 1 11.86 1 8C1 4.14 4.14 1 8 1ZM8 2C4.691 2 2 4.691 2 8C2 11.309 4.691 14 8 14C11.309 14 14 11.309 14 8C14 4.691 11.309 2 8 2Z"></path></svg>'
      },
      mismatch: {
        text: 'Files differ',
        iconSvg: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 2H2.5C1.673 2 1 2.673 1 3.5V12.5C1 13.327 1.673 14 2.5 14H5.5C6.327 14 7 13.327 7 12.5V3.5C7 2.673 6.327 2 5.5 2ZM2.5 3H5.5C5.775 3 6 3.224 6 3.5V5H2V3.5C2 3.224 2.225 3 2.5 3ZM5.5 13H2.5C2.225 13 2 12.776 2 12.5V6H6V12.5C6 12.776 5.775 13 5.5 13ZM13.5 2H10.5C9.673 2 9 2.673 9 3.5V12.5C9 13.327 9.673 14 10.5 14H13.5C14.327 14 15 13.327 15 12.5V3.5C15 2.673 14.327 2 13.5 2ZM10.5 3H13.5C13.775 3 14 3.224 14 3.5V8H10V3.5C10 3.224 10.225 3 10.5 3ZM13.5 13H10.5C10.225 13 10 12.776 10 12.5V10H14V12.5C14 12.776 13.775 13 13.5 13Z"></path></svg>'
      },
      missing_computer: {
        text: 'Missing on computer',
        iconSvg: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M14.831 11.965L9.206 1.714C8.965 1.274 8.503 1 8 1C7.497 1 7.035 1.274 6.794 1.714L1.169 11.965C1.059 12.167 1 12.395 1 12.625C1 13.383 1.617 14 2.375 14H13.625C14.383 14 15 13.383 15 12.625C15 12.395 14.941 12.167 14.831 11.965ZM13.625 13H2.375C2.168 13 2 12.832 2 12.625C2 12.561 2.016 12.5 2.046 12.445L7.671 2.195C7.736 2.075 7.863 2 8 2C8.137 2 8.264 2.075 8.329 2.195L13.954 12.445C13.984 12.501 14 12.561 14 12.625C14 12.832 13.832 13 13.625 13ZM8.75 11.25C8.75 11.664 8.414 12 8 12C7.586 12 7.25 11.664 7.25 11.25C7.25 10.836 7.586 10.5 8 10.5C8.414 10.5 8.75 10.836 8.75 11.25ZM7.5 9V5.5C7.5 5.224 7.724 5 8 5C8.276 5 8.5 5.224 8.5 5.5V9C8.5 9.276 8.276 9.5 8 9.5C7.724 9.5 7.5 9.276 7.5 9Z"></path></svg>'
      },
      missing_device: {
        text: 'Missing on device',
        iconSvg: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M14.831 11.965L9.206 1.714C8.965 1.274 8.503 1 8 1C7.497 1 7.035 1.274 6.794 1.714L1.169 11.965C1.059 12.167 1 12.395 1 12.625C1 13.383 1.617 14 2.375 14H13.625C14.383 14 15 13.383 15 12.625C15 12.395 14.941 12.167 14.831 11.965ZM13.625 13H2.375C2.168 13 2 12.832 2 12.625C2 12.561 2.016 12.5 2.046 12.445L7.671 2.195C7.736 2.075 7.863 2 8 2C8.137 2 8.264 2.075 8.329 2.195L13.954 12.445C13.984 12.501 14 12.561 14 12.625C14 12.832 13.832 13 13.625 13ZM8.75 11.25C8.75 11.664 8.414 12 8 12C7.586 12 7.25 11.664 7.25 11.25C7.25 10.836 7.586 10.5 8 10.5C8.414 10.5 8.75 10.836 8.75 11.25ZM7.5 9V5.5C7.5 5.224 7.724 5 8 5C8.276 5 8.5 5.224 8.5 5.5V9C8.5 9.276 8.276 9.5 8 9.5C7.724 9.5 7.5 9.276 7.5 9Z"></path></svg>'
      }
    };
    const libraryIconSvg = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1 3.24941C1 2.55938 1.55917 2 2.24895 2H2.74852C3.4383 2 3.99747 2.55938 3.99747 3.24941V12.745C3.99747 13.435 3.4383 13.9944 2.74852 13.9944H2.24895C1.55917 13.9944 1 13.435 1 12.745V3.24941ZM2.24895 2.99953C2.11099 2.99953 1.99916 3.11141 1.99916 3.24941V12.745C1.99916 12.883 2.11099 12.9948 2.24895 12.9948H2.74852C2.88648 12.9948 2.99831 12.883 2.99831 12.745V3.24941C2.99831 3.11141 2.88648 2.99953 2.74852 2.99953H2.24895ZM4.99663 3.24941C4.99663 2.55938 5.5558 2 6.24557 2H6.74515C7.43492 2 7.9941 2.55938 7.9941 3.24941V12.745C7.9941 13.435 7.43492 13.9944 6.74515 13.9944H6.24557C5.5558 13.9944 4.99663 13.435 4.99663 12.745V3.24941ZM6.24557 2.99953C6.10762 2.99953 5.99578 3.11141 5.99578 3.24941V12.745C5.99578 12.883 6.10762 12.9948 6.24557 12.9948H6.74515C6.88311 12.9948 6.99494 12.883 6.99494 12.745V3.24941C6.99494 3.11141 6.88311 2.99953 6.74515 2.99953H6.24557ZM11.9723 4.77682C11.7231 4.15733 11.0311 3.84331 10.4011 4.06385L9.81888 4.26764C9.14658 4.50297 8.80684 5.25222 9.07268 5.91326L12.0098 13.2166C12.2589 13.8361 12.9509 14.1502 13.581 13.9296L14.1632 13.7258C14.8355 13.4904 15.1752 12.7412 14.9093 12.0802L11.9723 4.77682ZM10.7311 5.00729C10.8571 4.96318 10.9955 5.02598 11.0453 5.14988L13.9824 12.4532C14.0356 12.5854 13.9676 12.7353 13.8332 12.7823L13.251 12.9862C13.1249 13.0303 12.9865 12.9675 12.9367 12.8436L9.99964 5.5402C9.94647 5.40799 10.0144 5.25815 10.1489 5.21108L10.7311 5.00729Z"></path></svg>';
    const folderIconSvg = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.75 3h3.6c.26 0 .51.1.7.28l1.1 1.06c.19.18.44.28.7.28h6.4A1.75 1.75 0 0 1 16 6.38v5.87A1.75 1.75 0 0 1 14.25 14H1.75A1.75 1.75 0 0 1 0 12.25V4.75A1.75 1.75 0 0 1 1.75 3Z"></path></svg>';

    if (rows.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 4;
      td.className = 'empty';
      td.textContent = 'No files to compare';
      tr.appendChild(td);
      tbody.appendChild(tr);
    } else {
      for (const row of rows) {
        const tr = document.createElement('tr');

        const pathTd = document.createElement('td');
        pathTd.className = 'path';
        pathTd.textContent = row.deviceRelativePath;
        tr.appendChild(pathTd);

        const scopeTd = document.createElement('td');
        scopeTd.className = 'scope';
        const scopeWrap = document.createElement('span');
        scopeWrap.className = 'scope-wrap';
        const scopeIcon = document.createElement('span');
        scopeIcon.className = 'scope-icon';
        scopeIcon.innerHTML = row.scopeIcon === 'library' ? libraryIconSvg : folderIconSvg;
        const scopeText = document.createElement('span');
        scopeText.textContent = row.scopeLabel || '';
        scopeWrap.appendChild(scopeIcon);
        scopeWrap.appendChild(scopeText);
        scopeTd.appendChild(scopeWrap);
        tr.appendChild(scopeTd);

        const statusTd = document.createElement('td');
        statusTd.className = 'status status-' + row.status;
        const wrap = document.createElement('span');
        wrap.className = 'status-wrap';
        const icon = document.createElement('span');
        icon.className = 'icon';
        icon.innerHTML = labels[row.status].iconSvg;
        const text = document.createElement('span');
        text.textContent = labels[row.status].text;
        wrap.appendChild(icon);
        wrap.appendChild(text);
        statusTd.appendChild(wrap);
        tr.appendChild(statusTd);

        const actionTd = document.createElement('td');
        actionTd.className = 'action';
        if (row.status === 'mismatch') {
          const action = document.createElement('button');
          action.type = 'button';
          action.className = 'link';
          action.textContent = 'Compare';
          action.addEventListener('click', () => {
            vscode.postMessage({ type: 'compare', rowId: row.id });
          });
          actionTd.appendChild(action);
        }
        tr.appendChild(actionTd);

        tbody.appendChild(tr);
      }
    }

    const syncToDeviceButton = document.getElementById('syncToDevice');
    if (syncToDeviceButton) {
      syncToDeviceButton.addEventListener('click', () => {
        vscode.postMessage({ type: 'sync_to_device' });
      });
    }

    const syncFromDeviceButton = document.getElementById('syncFromDevice');
    if (syncFromDeviceButton) {
      syncFromDeviceButton.addEventListener('click', () => {
        vscode.postMessage({ type: 'sync_from_device' });
      });
    }

    document.getElementById('close').addEventListener('click', () => {
      vscode.postMessage({ type: 'close' });
    });
  </script>
</body>
</html>`;
  }
}

class DeviceDeviceFileSystemProvider implements vscode.FileSystemProvider {
  private readonly onDidChangeFileEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.onDidChangeFileEmitter.event;
  private static readonly waitForConnectionSettingKey = 'deviceFileOpenWaitForConnectionMs';
  private static readonly defaultWaitForConnectionMs = 120000;
  private readonly statCache = new Map<string, vscode.FileStat>();
  private readonly backupRootPath: string;
  private deviceUriSegmentForId: (deviceId: string) => string = (deviceId) => deviceId;
  private deviceIdFromUriSegment: (segment: string) => string | undefined = (segment) => {
    const decoded = segment.trim();
    return decoded.length > 0 ? decoded : undefined;
  };

  constructor(private readonly context: vscode.ExtensionContext) {
    this.backupRootPath = path.join(this.context.globalStorageUri.fsPath, 'device-working-copy');
  }

  setDeviceUriResolvers(
    getDeviceUriSegment: (deviceId: string) => string,
    resolveDeviceIdFromUriSegment: (segment: string) => string | undefined
  ): void {
    this.deviceUriSegmentForId = getDeviceUriSegment;
    this.deviceIdFromUriSegment = resolveDeviceIdFromUriSegment;
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const { deviceId, relativePath } = this.toDeviceAndRelativeDevicePathOrRoot(uri);
    const board = await this.getConnectedPyDeviceOrWait(deviceId);
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
    const { deviceId, relativePath } = this.toDeviceAndRelativeDevicePathOrRoot(uri);
    if (!deviceId) {
      const roots = getConnectedPyDevices().map((item) => [encodeURIComponent(this.deviceUriSegmentForId(item.deviceId)), vscode.FileType.Directory] as [string, vscode.FileType]);
      return roots.sort((a, b) => a[0].localeCompare(b[0]));
    }

    const board = await this.getConnectedPyDeviceOrWait(deviceId);
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
    const { deviceId, relativePath } = this.toDeviceAndRelativeDevicePathOrRoot(uri);
    const board = await this.getConnectedPyDeviceOrWait(deviceId);
    if (!relativePath) {
      return;
    }

    await createDeviceDirectory(board, relativePath);
    const createdUri = this.toDeviceUri(deviceId ?? '', relativePath);
    this.statCache.delete(createdUri.toString());
    this.onDidChangeFileEmitter.fire([{ type: vscode.FileChangeType.Created, uri: createdUri }]);
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const fallbackFilePath = this.describeDevicePath(uri);
    const { deviceId } = this.toDeviceAndRelativeDevicePathOrRoot(uri);
    let board: NonNullable<ReturnType<typeof getConnectedPyDevice>>;
    try {
      board = await this.getConnectedPyDeviceOrWait(deviceId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const friendlyMessage = `device no longer available for the file. File: ${fallbackFilePath}. ${this.getDeviceDetails()}`;
      vscode.window.showWarningMessage(friendlyMessage);
      logChannelOutput(`Device file not opened. ${friendlyMessage}`, true);
      await this.closeDeviceTabsForUriWithRetry(uri);
      throw vscode.FileSystemError.Unavailable(`${friendlyMessage} (${message})`);
    }

    const relativePath = this.toRelativeDevicePath(uri, board);
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
          logChannelOutput(`Device file not opened. ${friendlyMessage}`, true);
          await this.closeDeviceTabsForUriWithRetry(uri);
        }
        throw vscode.FileSystemError.FileNotFound(uri);
      }
      const readFailureMessage = `failed to open device file. File: ${relativePath}. ${this.getDeviceDetails(board)}. ${message}`;
      logChannelOutput(`Device file not opened. ${readFailureMessage}`, true);
      await this.closeDeviceTabsForUriWithRetry(uri);
      throw vscode.FileSystemError.Unavailable(`Failed to read device file: ${relativePath}. ${message}`);
    }
  }

  async writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    options: { readonly create: boolean; readonly overwrite: boolean }
  ): Promise<void> {
    const { deviceId } = this.toDeviceAndRelativeDevicePathOrRoot(uri);
    const board = await this.getConnectedPyDeviceOrWait(deviceId);
    const relativePath = this.toRelativeDevicePath(uri, board);
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
      throw vscode.FileSystemError.Unavailable(`Failed to write device file: ${relativePath}. ${message}`);
    }
  }

  async delete(uri: vscode.Uri, options: { readonly recursive: boolean }): Promise<void> {
    const { deviceId } = this.toDeviceAndRelativeDevicePathOrRoot(uri);
    const board = await this.getConnectedPyDeviceOrWait(deviceId);
    const relativePath = this.toRelativeDevicePathOrRoot(uri, board);
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
    await this.notifyDevicePathDeleted(relativePath, true);
    this.onDidChangeFileEmitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
  }

  async rename(
    oldUri: vscode.Uri,
    newUri: vscode.Uri,
    options: { readonly overwrite: boolean }
  ): Promise<void> {
    const { deviceId } = this.toDeviceAndRelativeDevicePathOrRoot(oldUri);
    const board = await this.getConnectedPyDeviceOrWait(deviceId);
    const sourcePath = this.toRelativeDevicePath(oldUri, board);
    const targetPath = this.toRelativeDevicePath(newUri, board);
    const entries = await listDeviceEntries(board);
    const targetExists = entries.some((entry) => entry.relativePath === targetPath);
    if (targetExists && !options.overwrite) {
      throw vscode.FileSystemError.FileExists(newUri);
    }

    if (targetExists && options.overwrite) {
      await deleteDevicePath(board, targetPath);
      await this.notifyDevicePathDeleted(targetPath, true);
    }

    await renameDevicePath(board, sourcePath, targetPath);
    await this.notifyDevicePathDeleted(sourcePath, true);
    await this.notifyDeviceFilesChanged([targetPath]);
    this.onDidChangeFileEmitter.fire([
      { type: vscode.FileChangeType.Deleted, uri: oldUri },
      { type: vscode.FileChangeType.Created, uri: newUri }
    ]);
  }

  notifyConnectedDeviceRootsChanged(previousDeviceIds: string[], nextDeviceIds: string[]): void {
    const previous = new Set(previousDeviceIds);
    const next = new Set(nextDeviceIds);
    const events: vscode.FileChangeEvent[] = [];

    const rootUri = vscode.Uri.parse(`${deviceDocumentScheme}:/`);
    events.push({ type: vscode.FileChangeType.Changed, uri: rootUri });

    for (const deviceId of previous) {
      if (next.has(deviceId)) {
        continue;
      }
      const deletedUri = this.toDeviceUri(deviceId, '');
      this.statCache.delete(deletedUri.toString());
      events.push({ type: vscode.FileChangeType.Deleted, uri: deletedUri });
    }

    for (const deviceId of next) {
      if (previous.has(deviceId)) {
        continue;
      }
      const createdUri = this.toDeviceUri(deviceId, '');
      this.statCache.delete(createdUri.toString());
      events.push({ type: vscode.FileChangeType.Created, uri: createdUri });
    }

    this.onDidChangeFileEmitter.fire(events);
  }

  async notifyDeviceFilesChanged(relativePaths: string[], deviceId?: string): Promise<void> {
    if (relativePaths.length === 0) {
      return;
    }

    const uniqueRelativePaths = [...new Set(relativePaths.map((item) => toRelativePath(item)).filter((item) => item.length > 0))];
    if (uniqueRelativePaths.length === 0) {
      return;
    }

    const events: vscode.FileChangeEvent[] = [];
    const targetDeviceId = deviceId ?? getConnectedPyDevices()[0]?.deviceId ?? '';
    for (const relativePath of uniqueRelativePaths) {
      const uri = this.toDeviceUri(targetDeviceId, relativePath);
      this.statCache.delete(uri.toString());
      events.push({ type: vscode.FileChangeType.Changed, uri });
    }

    this.onDidChangeFileEmitter.fire(events);
  }

  async notifyDevicePathDeleted(relativePath: string, includeDescendants: boolean): Promise<void> {
    const normalisedTarget = toRelativePath(relativePath);
    if (!normalisedTarget) {
      return;
    }

    const uriMap = new Map<string, vscode.Uri>();
    const registerUri = (uri: vscode.Uri): void => {
      if (uri.scheme !== deviceDocumentScheme) {
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
      await this.closeDeviceTabsForUriWithRetry(uri);
      events.push({ type: vscode.FileChangeType.Deleted, uri });
    }

    this.onDidChangeFileEmitter.fire(events);
  }

  private toRelativeDevicePath(uri: vscode.Uri, board: NonNullable<ReturnType<typeof getConnectedPyDevice>>): string {
    const rawPath = toRelativePath(uri.path.replace(/^\/+/, ''));
    const segments = rawPath
      .split('/')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);

    if (segments.length === 0) {
      throw vscode.FileSystemError.FileNotFound('Device file path is empty.');
    }

    if (segments[0].endsWith(':') && segments.length > 1) {
      segments.shift();
    }

    const queryDeviceId = new URLSearchParams(uri.query).get('deviceId')?.trim();
    if (queryDeviceId && segments.length > 1) {
      segments.shift();
    } else {
      const decodedFirst = this.decodeDeviceDeviceSegment(segments[0]);
      const resolvedDeviceId = decodedFirst ? this.deviceIdFromUriSegment(decodedFirst) : undefined;
      if (resolvedDeviceId && segments.length > 1) {
        segments.shift();
      }
    }

    const deviceName = (path.basename(board.device) || board.device).replace(/[^\w.-]/g, '_');
    if (segments[0] === deviceName && segments.length > 1) {
      segments.shift();
    }

    const relativePath = toRelativePath(segments.join('/'));
    if (!relativePath) {
      throw vscode.FileSystemError.FileNotFound('Device file path is empty.');
    }

    return relativePath;
  }

  private toRelativeDevicePathOrRoot(uri: vscode.Uri, board: NonNullable<ReturnType<typeof getConnectedPyDevice>>): string {
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

    const queryDeviceId = new URLSearchParams(uri.query).get('deviceId')?.trim();
    if (queryDeviceId && segments.length > 1) {
      segments.shift();
    } else {
      const decodedFirst = this.decodeDeviceDeviceSegment(segments[0]);
      const resolvedDeviceId = decodedFirst ? this.deviceIdFromUriSegment(decodedFirst) : undefined;
      if (resolvedDeviceId && segments.length > 1) {
        segments.shift();
      }
    }

    const deviceName = (path.basename(board.device) || board.device).replace(/[^\w.-]/g, '_');
    if (segments[0] === deviceName && segments.length > 1) {
      segments.shift();
    }

    return toRelativePath(segments.join('/'));
  }

  private toDeviceUri(deviceId: string, relativePath: string): vscode.Uri {
    const deviceSegment = encodeURIComponent(this.deviceUriSegmentForId(deviceId));
    const normalised = toRelativePath(relativePath).replace(/^\/+/, '');
    return vscode.Uri.parse(`${deviceDocumentScheme}:/${deviceSegment}/${normalised}?deviceId=${encodeURIComponent(deviceId)}`);
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
    if (document.uri.scheme !== deviceDocumentScheme) {
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
    if (uri.scheme !== deviceDocumentScheme) {
      return;
    }

    await this.removeWorkingCopy(uri);
  }

  async restoreWorkingCopyToDocument(document: vscode.TextDocument): Promise<void> {
    if (document.uri.scheme !== deviceDocumentScheme || document.isClosed) {
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

  private async getConnectedPyDeviceOrWait(deviceId?: string): Promise<NonNullable<ReturnType<typeof getConnectedPyDevice>>> {
    const connected = getConnectedPyDevice(deviceId);
    if (connected) {
      return connected;
    }

    const configuredWait = vscode.workspace
      .getConfiguration('mekatrol.pydevice')
      .get<number>(
        DeviceDeviceFileSystemProvider.waitForConnectionSettingKey,
        DeviceDeviceFileSystemProvider.defaultWaitForConnectionMs
      );
    const timeoutMs = Number.isFinite(configuredWait)
      ? Math.max(0, configuredWait)
      : DeviceDeviceFileSystemProvider.defaultWaitForConnectionMs;

    return await new Promise((resolve, reject) => {
      let timeout: NodeJS.Timeout | undefined;
      const disposable = onBoardConnectionStateChanged(() => {
        const board = getConnectedPyDevice(deviceId);
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

  private getDeviceDetails(board?: NonNullable<ReturnType<typeof getConnectedPyDevice>>): string {
    const activeBoard = board ?? getConnectedPyDevice();
    const device = activeBoard?.device ?? 'unknown device';
    const baudRate = activeBoard?.baudrate ?? defaultBaudRate;
    const connectionState = activeBoard ? 'connected' : 'disconnected';
    return `Device: ${device} @ ${baudRate} (${connectionState})`;
  }

  private describeDevicePath(uri: vscode.Uri, board?: NonNullable<ReturnType<typeof getConnectedPyDevice>>): string {
    if (board) {
      return this.toRelativeDevicePath(uri, board);
    }

    const rawPath = toRelativePath(uri.path.replace(/^\/+/, ''));
    return rawPath || '<unknown>';
  }

  private decodeDeviceDeviceSegment(segment: string): string {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  }

  private toDeviceAndRelativeDevicePathOrRoot(uri: vscode.Uri): { deviceId: string | undefined; relativePath: string } {
    const rawPath = toRelativePath(uri.path.replace(/^\/+/, ''));
    if (!rawPath) {
      return { deviceId: undefined, relativePath: '' };
    }

    const segments = rawPath.split('/').map((item) => item.trim()).filter((item) => item.length > 0);
    if (segments.length === 0) {
      return { deviceId: undefined, relativePath: '' };
    }

    const queryDeviceId = new URLSearchParams(uri.query).get('deviceId')?.trim();
    const decodedDeviceId = this.decodeDeviceDeviceSegment(segments[0]);
    const resolvedDeviceId = this.deviceIdFromUriSegment(decodedDeviceId);
    const effectiveDeviceId = queryDeviceId && queryDeviceId.length > 0
      ? queryDeviceId
      : (resolvedDeviceId ?? decodedDeviceId);
    const hasDevicePrefix = !!effectiveDeviceId || segments.length > 1;
    if (!hasDevicePrefix) {
      return { deviceId: undefined, relativePath: rawPath };
    }

    return {
      deviceId: effectiveDeviceId,
      relativePath: toRelativePath(segments.slice(1).join('/'))
    };
  }

  private async closeDeviceTabsForUriWithRetry(uri: vscode.Uri): Promise<void> {
    await this.closeDeviceTabsForUri(uri);
    await this.delay(50);
    await this.closeDeviceTabsForUri(uri);
    await this.delay(250);
    await this.closeDeviceTabsForUri(uri);
  }

  private async closeDeviceTabsForUri(uri: vscode.Uri): Promise<void> {
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

class SyncTreeProvider implements vscode.TreeDataProvider<SyncNode>, vscode.Disposable {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<SyncNode | undefined>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private readonly modelDisposable: vscode.Disposable;

  constructor(private readonly model: DeviceSyncModel) {
    this.modelDisposable = model.onDidChangeData(() => this.onDidChangeTreeDataEmitter.fire(undefined));
  }

  dispose(): void {
    this.modelDisposable.dispose();
    this.onDidChangeTreeDataEmitter.dispose();
  }

  getTreeItem(element: SyncNode): vscode.TreeItem {
    const data = element.data;
    element.tooltip = undefined;

    if (data.isRoot) {
      element.contextValue = data.side === 'computer' ? 'pydevice.hostRoot' : 'pydevice.deviceRoot';
      element.iconPath = data.side === 'computer' ? new vscode.ThemeIcon('desktop-download') : new vscode.ThemeIcon('device-mobile');
      if (data.side === 'device') {
        const count = this.model.getConnectedDeviceIds().length;
        element.description = count > 0 ? `${count} connected` : 'disconnected';
      } else {
        const mappedCount = this.model.getMappedHostFolderCount();
        element.description = mappedCount > 0
          ? `${mappedCount} mapped`
          : `${this.model.getAvailableHostFolderCount()} computer folders`;
      }
      element.command = undefined;
      return element;
    }

    if (data.isIndicator) {
      element.contextValue = 'pydevice.deviceIndicator';
      element.iconPath = new vscode.ThemeIcon('files');
      element.description = 'setup required';
      element.tooltip = 'Click to open Explorer view and complete setup.';
      element.command = this.model.hasWorkspaceFolder()
        ? { command: commandExplorerInitialiseWorkspaceId, title: 'Initialize PyDevice Workspace' }
        : { command: commandExplorerPrerequisitesHintId, title: 'Setup PyDevice Explorer' };
      return element;
    }

    if (data.isDeviceIdNode) {
      const mappedFolder = data.deviceId ? this.model.getMappedHostFolder(data.deviceId) : undefined;
      if (data.side === 'device') {
        element.contextValue = mappedFolder ? 'pydevice.deviceIdNodeMapped' : 'pydevice.deviceIdNode';
      } else {
        element.contextValue = 'pydevice.hostDeviceMappingNode';
      }
      element.iconPath = new vscode.ThemeIcon('device-mobile');
      if (data.deviceId) {
        const name = this.model.getDeviceName(data.deviceId);
        if (name) {
          element.tooltip = `${name}\n${data.deviceId}`;
        }
        if (data.side === 'device') {
          const connected = this.model.getConnectedDevice(data.deviceId);
          const state = connected ? 'connected' : 'disconnected';
          element.description = mappedFolder ? `${state} | computer:${mappedFolder}` : state;
        } else {
          element.description = mappedFolder ?? 'not mapped';
        }
      } else {
        element.description = data.side === 'device' ? 'connected' : 'sync';
      }
      element.command = undefined;
      return element;
    }

    if (data.isLibraryNode) {
      element.contextValue = data.isLibraryMissing ? 'pydevice.deviceLibraryNodeMissing' : 'pydevice.deviceLibraryNode';
      element.iconPath = data.isLibraryMissing ? new vscode.ThemeIcon('warning') : new vscode.ThemeIcon('library');
      if (data.libraryHostFolder) {
        element.description = data.isLibraryMissing ? `missing | ${data.libraryHostFolder}` : data.libraryHostFolder;
        element.tooltip = `${data.libraryHostFolder} -> /${data.relativePath}`;
      }
      element.command = undefined;
      return element;
    }

    const isExcludedFromSync = this.model.isNodePathExcludedFromSync(data);
    let compareAvailability: DeviceFileCompareAvailability = 'available';
    if (data.side === 'device') {
      if (data.isDirectory) {
        element.contextValue = isExcludedFromSync ? 'pydevice.deviceFolderExcluded' : 'pydevice.deviceFolder';
      } else {
        compareAvailability = this.model.getDeviceFileCompareAvailability(data);
        if (isExcludedFromSync) {
          element.contextValue = compareAvailability === 'unmapped'
            ? 'pydevice.deviceFileExcludedUnmapped'
            : (compareAvailability === 'hostMissing' ? 'pydevice.deviceFileExcludedHostMissing' : 'pydevice.deviceFileExcludedMapped');
        } else {
          element.contextValue = compareAvailability === 'unmapped'
            ? 'pydevice.deviceFileUnmapped'
            : (compareAvailability === 'hostMissing' ? 'pydevice.deviceFileHostMissing' : 'pydevice.deviceFileMapped');
        }
      }
      element.command = data.isDirectory ? undefined : { command: commandOpenDeviceFileFromTreeId, title: 'Open', arguments: [element] };
    } else {
      if (data.isDirectory) {
        element.contextValue = isExcludedFromSync ? 'pydevice.hostFolderExcluded' : 'pydevice.hostFolder';
      } else {
        element.contextValue = isExcludedFromSync ? 'pydevice.hostFileExcluded' : 'pydevice.hostFile';
      }
      element.command = data.isDirectory ? undefined : { command: commandOpenComputerItemFromTreeId, title: 'Open', arguments: [element] };
    }
    element.iconPath = data.isDirectory ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;
    element.description = isExcludedFromSync ? 'excluded' : undefined;
    if (data.side === 'device' && !data.isDirectory && compareAvailability === 'hostMissing') {
      const compareHint = 'Compare unavailable: file does not exist on mapped computer folder.';
      element.tooltip = element.tooltip ? `${element.tooltip}\n${compareHint}` : compareHint;
    }

    return element;
  }

  getParent(element: SyncNode): SyncNode | undefined {
    const sameNode = (a: SyncNode, b: SyncNode): boolean => {
      return a.data.side === b.data.side
        && toRelativePath(a.data.relativePath) === toRelativePath(b.data.relativePath)
        && (a.data.deviceId ?? '') === (b.data.deviceId ?? '')
        && (a.data.libraryHostFolder ?? '') === (b.data.libraryHostFolder ?? '')
        && (a.data.libraryDeviceRoot ?? '') === (b.data.libraryDeviceRoot ?? '')
        && !!a.data.isLibraryNode === !!b.data.isLibraryNode
        && !!a.data.isRoot === !!b.data.isRoot
        && !!a.data.isDeviceIdNode === !!b.data.isDeviceIdNode
        && !!a.data.isIndicator === !!b.data.isIndicator
        && a.data.isDirectory === b.data.isDirectory;
    };

    const queue: Array<{ node: SyncNode; parent?: SyncNode }> = this.getChildren().map((node) => ({ node }));
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (sameNode(current.node, element)) {
        return current.parent;
      }

      const children = this.getChildren(current.node);
      for (const child of children) {
        queue.push({ node: child, parent: current.node });
      }
    }

    return undefined;
  }

  getChildren(element?: SyncNode): SyncNode[] {
    if (!this.model.isExplorerReady()) {
      let label = 'Open a folder in Explorer to enable PyDevice Explorer';
      if (this.model.hasWorkspaceFolder()) {
        const missing: string[] = [];
        if (!this.model.hasConfigurationFolder()) {
          missing.push(configurationFileName);
        }
        label = missing.length > 0
          ? 'Initialize PyDevice Workspace'
          : 'Complete PyDevice Explorer setup';
      }
      return [
        new SyncNode(
          {
            side: 'device',
            relativePath: '__setup_required__',
            isDirectory: false,
            isIndicator: true
          },
          label,
          vscode.TreeItemCollapsibleState.None
        )
      ];
    }

    if (!element) {
      return [
        new SyncNode(
          {
            side: 'computer',
            relativePath: '',
            isDirectory: true,
            isRoot: true
          },
          'COMPUTER',
          vscode.TreeItemCollapsibleState.Expanded
        ),
        new SyncNode(
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
      if (element.data.side === 'computer') {
        const mappedHostDeviceIds = this.model.getMappedHostDeviceIds();
        if (mappedHostDeviceIds.length > 0) {
          const mappedByFolder = new Map<string, string>();
          for (const deviceId of mappedHostDeviceIds) {
            const mappedFolder = this.model.getMappedHostFolder(deviceId);
            const folderKey = mappedFolder && mappedFolder.trim().length > 0
              ? toRelativePath(mappedFolder)
              : `__device__/${deviceId}`;
            if (!mappedByFolder.has(folderKey)) {
              mappedByFolder.set(folderKey, deviceId);
            }
          }

          return [...mappedByFolder.entries()]
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([folderKey, deviceId]) => {
              const label = folderKey.startsWith('__device__/')
                ? this.model.getDeviceDisplayName(deviceId)
                : path.posix.basename(folderKey);
              return new SyncNode(
              {
                side: 'computer',
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
            new SyncNode(
              {
                side: 'computer',
                relativePath: '',
                isDirectory: false,
                isIndicator: true
              },
              'No computer folders',
              vscode.TreeItemCollapsibleState.None
            )
          ];
        }

        return availableHostFolders.map((folderPath) => {
          const label = path.posix.basename(folderPath);
          return new SyncNode(
            {
              side: 'computer',
              relativePath: label,
              isDirectory: true
            },
            label,
            vscode.TreeItemCollapsibleState.Collapsed
          );
        });
      }

      const deviceIds = this.model.getKnownDeviceIds();
      if (deviceIds.length === 0) {
        return [];
      }

      return deviceIds.map((deviceId) => {
        const connected = this.model.getConnectedDevice(deviceId);
        const name = this.model.getDeviceName(deviceId);
        const label = name ?? (connected ? this.toDeviceLeafLabel(connected) : deviceId);
        return new SyncNode(
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
    if (element.data.side === 'device' && element.data.isDeviceIdNode && element.data.deviceId) {
      const libraries = this.model.getDeviceLibraryMappings(element.data.deviceId);
      const libraryNodes = libraries.map((library) =>
        new SyncNode(
          {
            side: 'device',
            relativePath: library.devicePath,
            isDirectory: true,
            deviceId: element.data.deviceId,
            libraryHostFolder: library.hostRelativePath,
            libraryDeviceRoot: library.devicePath,
            isLibraryNode: true,
            isLibraryMissing: library.missing
          },
          library.devicePath,
          vscode.TreeItemCollapsibleState.Collapsed
        )
      );
      const libraryDevicePaths = new Set(libraries.map((library) => library.devicePath));
      const deviceNodes = this.model.getNodeChildren(
        element.data.side,
        '',
        element.data.deviceId
      ).filter((node) => !libraryDevicePaths.has(toRelativePath(node.data.relativePath)));
      return [...libraryNodes, ...deviceNodes];
    }

    return this.model.getNodeChildren(
      element.data.side,
      element.data.isDeviceIdNode ? '' : element.data.relativePath,
      element.data.deviceId,
      element.data.libraryHostFolder && element.data.libraryDeviceRoot
        ? {
          hostRelativePath: element.data.libraryHostFolder,
          devicePath: element.data.libraryDeviceRoot,
          missing: !!element.data.isLibraryMissing
        }
        : undefined
    );
  }

  private toSerialPortName(devicePath: string): string {
    return path.basename(devicePath) || devicePath;
  }

  private toDeviceLeafLabel(
    device: ReturnType<DeviceSyncModel['getConnectedDevice']> extends infer T ? T : never
  ): string {
    const machine = device?.runtimeInfo?.machine?.trim() || 'Unknown device';
    const port = this.toSerialPortName(device?.devicePath ?? '');
    const deviceId = device?.deviceId ?? 'unknown';
    return `${machine} [${port}: ${deviceId}]`;
  }
}

const hostWorkspaceFolderName = 'COMPUTER';
const deviceWorkspaceFolderName = 'DEVICE';
const mountHostWorkspaceFolderSettingKey = 'mountHostInWorkspaceExplorer';
const mountDeviceWorkspaceFolderSettingKey = 'mountDeviceInWorkspaceExplorer';

const ensureNativeExplorerRoots = async (model: DeviceSyncModel): Promise<void> => {
  const syncRootPath = model.getSyncRootPath();
  const deviceUri = vscode.Uri.parse(`${deviceDocumentScheme}:/`);
  const configuration = vscode.workspace.getConfiguration('mekatrol.pydevice');
  const mountHostWorkspaceFolder = configuration.get<boolean>(mountHostWorkspaceFolderSettingKey, false);
  const mountDeviceWorkspaceFolder = configuration.get<boolean>(mountDeviceWorkspaceFolderSettingKey, false);
  const existing = vscode.workspace.workspaceFolders ?? [];
  const hostUri = syncRootPath ? vscode.Uri.file(syncRootPath) : undefined;
  const existingHostIndex = hostUri
    ? existing.findIndex((folder) => folder.uri.toString() === hostUri.toString())
    : -1;
  const existingDeviceIndex = existing.findIndex((folder) => folder.uri.toString() === deviceUri.toString());

  if ((!mountHostWorkspaceFolder || !hostUri) && existingHostIndex >= 0) {
    vscode.workspace.updateWorkspaceFolders(existingHostIndex, 1);
  }

  if (!mountDeviceWorkspaceFolder && existingDeviceIndex >= 0) {
    vscode.workspace.updateWorkspaceFolders(existingDeviceIndex, 1);
  }

  const currentFolders = vscode.workspace.workspaceFolders ?? [];
  const hostExists = hostUri
    ? currentFolders.some((folder) => folder.uri.toString() === hostUri.toString())
    : false;
  const deviceExists = currentFolders.some((folder) => folder.uri.toString() === deviceUri.toString());

  const additions: { uri: vscode.Uri; name: string }[] = [];
  if (mountHostWorkspaceFolder && hostUri && !hostExists) {
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

export const initDeviceSyncExplorer = async (context: vscode.ExtensionContext): Promise<void> => {
  const deviceFsProvider = new DeviceDeviceFileSystemProvider(context);
  let lastConnectedDeviceIds = getConnectedPyDevices().map((item) => item.deviceId).sort((a, b) => a.localeCompare(b));
  const model = new DeviceSyncModel(context, async (relativePaths: string[]) => {
    await deviceFsProvider.notifyDeviceFilesChanged(relativePaths, model.getActiveDeviceId());
  }, async (relativePath: string, includeDescendants: boolean) => {
    await deviceFsProvider.notifyDevicePathDeleted(relativePath, includeDescendants);
  }, async (target) => {
    const findNodeByData = (
      side: NodeSide,
      relativePath: string,
      deviceId?: string
    ): SyncNode | undefined => {
      const targetPath = toRelativePath(relativePath);
      const stack: SyncNode[] = [...provider.getChildren()];
      while (stack.length > 0) {
        const current = stack.shift()!;
        const currentPath = toRelativePath(current.data.relativePath);
        if (
          current.data.side === side &&
          currentPath === targetPath &&
          current.data.deviceId === deviceId &&
          current.data.isDirectory
        ) {
          return current;
        }

        if (!current.data.isDirectory || current.data.isIndicator) {
          continue;
        }

        stack.push(...provider.getChildren(current));
      }

      return undefined;
    };

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const node = findNodeByData(target.side, target.relativePath, target.deviceId);
      if (node) {
        try {
          await treeView.reveal(node, { expand: true, focus: false, select: false });
          return;
        } catch {
          // Retry below.
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  });
  deviceFsProvider.setDeviceUriResolvers(
    (deviceId: string) => model.getDeviceUriSegment(deviceId),
    (segment: string) => model.resolveDeviceIdFromUriSegment(segment)
  );

  const provider = new SyncTreeProvider(model);

  context.subscriptions.push(provider);
  const treeView = vscode.window.createTreeView(syncViewId, { treeDataProvider: provider });
  context.subscriptions.push(treeView);
  context.subscriptions.push(vscode.workspace.registerFileSystemProvider(deviceDocumentScheme, deviceFsProvider, { isCaseSensitive: true }));

  context.subscriptions.push(treeView.onDidChangeSelection(async (event) => {
    const node = event.selection[0];
    model.setSelectedDeviceNode(node);
  }));

  context.subscriptions.push(treeView.onDidChangeVisibility((event) => {
    if (!event.visible || !model.isBoardConnected()) {
      return;
    }

    void model.refresh(true);
  }));

  const deviceExplorerAutoRefreshTimer = setInterval(() => {
    if (!treeView.visible || !model.isBoardConnected()) {
      return;
    }

    void model.refresh(true);
  }, deviceExplorerAutoRefreshIntervalMs);
  context.subscriptions.push(new vscode.Disposable(() => clearInterval(deviceExplorerAutoRefreshTimer)));

  context.subscriptions.push(onBoardConnectionStateChanged(() => model.refresh()));
  context.subscriptions.push(onBoardConnectionsChanged((snapshots) => {
    const nextConnectedDeviceIds = snapshots.map((item) => item.deviceId).sort((a, b) => a.localeCompare(b));
    deviceFsProvider.notifyConnectedDeviceRootsChanged(lastConnectedDeviceIds, nextConnectedDeviceIds);
    lastConnectedDeviceIds = nextConnectedDeviceIds;
    void ensureNativeExplorerRoots(model);
    void model.refresh();
  }));
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument((document) => model.handleDocumentSaved(document)));
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((event) => void deviceFsProvider.updateWorkingCopyFromDocument(event.document)));
  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument((document) => void deviceFsProvider.restoreWorkingCopyToDocument(document)));
  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((document) => {
      if (document.uri.scheme === deviceDocumentScheme && !document.isDirty) {
        void deviceFsProvider.clearWorkingCopy(document.uri);
      }
    })
  );
  context.subscriptions.push(vscode.workspace.onDidDeleteFiles((event) => event.files.forEach((uri) => model.handlePossibleSyncFileChange(uri.fsPath))));
  context.subscriptions.push(vscode.workspace.onDidCreateFiles((event) => event.files.forEach((uri) => model.handlePossibleSyncFileChange(uri.fsPath))));

  context.subscriptions.push(vscode.commands.registerCommand(commandRefreshId, async () => model.refresh(true)));
  context.subscriptions.push(vscode.commands.registerCommand(commandSyncFromDeviceId, async () => model.syncFromDevice()));
  context.subscriptions.push(vscode.commands.registerCommand(commandSyncToDeviceId, async () => model.syncToDevice()));
  context.subscriptions.push(vscode.commands.registerCommand(commandSyncNodeFromDeviceId, async (node?: SyncNode) => model.syncNodeFromDevice(node)));
  context.subscriptions.push(vscode.commands.registerCommand(commandSyncNodeToDeviceId, async (node?: SyncNode) => model.syncNodeToDevice(node)));
  context.subscriptions.push(vscode.commands.registerCommand(commandOpenComputerItemId, async (node: SyncNode) => model.openComputerNode(node)));
  context.subscriptions.push(vscode.commands.registerCommand(commandPullAndOpenDeviceItemId, async (node: SyncNode) => model.pullDeviceNodeAndOpen(node)));
  context.subscriptions.push(vscode.commands.registerCommand(commandOpenDeviceFileId, async (node?: SyncNode) => model.openDeviceFile(node)));
  context.subscriptions.push(
    vscode.commands.registerCommand(commandOpenComputerItemFromTreeId, async (node: SyncNode) => model.openComputerNode(node, { explorerClick: true }))
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(commandOpenDeviceFileFromTreeId, async (node?: SyncNode) => model.openDeviceFile(node, { explorerClick: true }))
  );
  context.subscriptions.push(vscode.commands.registerCommand(commandCompareDeviceWithComputerId, async (node?: SyncNode) => model.compareDeviceWithComputer(node)));
  context.subscriptions.push(vscode.commands.registerCommand(commandCompareDeviceFilesId, async (node?: SyncNode) => model.compareDeviceFiles(node)));
  context.subscriptions.push(vscode.commands.registerCommand(commandCreateSyncFileId, async (node?: SyncNode) => model.createSyncFile(node)));
  context.subscriptions.push(vscode.commands.registerCommand(commandCreateSyncFolderId, async (node?: SyncNode) => model.createSyncFolder(node)));
  context.subscriptions.push(vscode.commands.registerCommand(commandRenameSyncPathId, async (node?: SyncNode) => model.renameSyncPath(node)));
  context.subscriptions.push(vscode.commands.registerCommand(commandDeleteSyncPathId, async (node?: SyncNode) => model.deleteSyncPath(node)));
  context.subscriptions.push(vscode.commands.registerCommand(commandMapDeviceHostFolderId, async (node?: SyncNode) => model.mapDeviceToHostFolder(node)));
  context.subscriptions.push(vscode.commands.registerCommand(commandUnmapDeviceHostFolderId, async (node?: SyncNode) => model.unmapDeviceFromHostFolder(node)));
  context.subscriptions.push(vscode.commands.registerCommand(commandAddDeviceLibraryFolderId, async (node?: SyncNode) => model.addDeviceLibraryFolder(node)));
  context.subscriptions.push(vscode.commands.registerCommand(commandRemoveDeviceLibraryFolderId, async (node?: SyncNode) => model.removeDeviceLibraryFolder(node)));
  context.subscriptions.push(vscode.commands.registerCommand(commandSetDeviceNameId, async (node?: SyncNode) => model.setDeviceName(node)));
  context.subscriptions.push(vscode.commands.registerCommand(commandExcludeDeviceFileFromSyncId, async (node?: SyncNode) => model.excludeDeviceFileFromSync(node)));
  context.subscriptions.push(vscode.commands.registerCommand(commandRemoveDeviceFileFromSyncExclusionId, async (node?: SyncNode) => model.removeDeviceFileFromSyncExclusion(node)));
  context.subscriptions.push(vscode.commands.registerCommand(commandCloseDeviceConnectionId, async (node?: SyncNode) => model.closeDeviceConnection(node)));
  context.subscriptions.push(vscode.commands.registerCommand(commandCloseAllDeviceConnectionsId, async () => model.closeAllDeviceConnections()));
  context.subscriptions.push(vscode.commands.registerCommand(commandConnectBoardWithPickerId, async () => {
    await vscode.commands.executeCommand('mekatrol.pydevice.connectboard', { forcePickPort: true });
  }));
  context.subscriptions.push(vscode.commands.registerCommand(commandExplorerPrerequisitesHintId, async () => {
    await vscode.commands.executeCommand('workbench.view.explorer');
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      const action = await vscode.window.showWarningMessage(
        'Open a workspace folder first to enable PyDevice Explorer.',
        'Open Folder'
      );
      if (action === 'Open Folder') {
        await vscode.commands.executeCommand('vscode.openFolder');
      }
      return;
    }

    const configUri = workspaceFolder.uri.with({
      path: path.posix.join(workspaceFolder.uri.path, configurationFileName)
    });
    try {
      await vscode.workspace.fs.stat(configUri);
    } catch {
      const action = await vscode.window.showWarningMessage(
        `${configurationFileName} was not found in this workspace. Create it to enable PyDevice Explorer.`,
        `Create ${configurationFileName}`
      );
      if (action === `Create ${configurationFileName}`) {
        await vscode.commands.executeCommand('mekatrol.pydevice.initconfig');
      }
      return;
    }

    vscode.window.showInformationMessage('PyDevice Explorer is ready.');
  }));
  context.subscriptions.push(vscode.commands.registerCommand(commandExplorerInitialiseWorkspaceId, async () => {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      const action = await vscode.window.showWarningMessage(
        'Open a workspace folder first to Initialize PyDevice Workspace.',
        'Open Folder'
      );
      if (action === 'Open Folder') {
        await vscode.commands.executeCommand('vscode.openFolder');
      }
      return;
    }

    const createdItems: string[] = [];
    const existingItems: string[] = [];

    const [configResult] = await createDefaultConfiguration();
    if (configResult === PyDeviceConfigurationResult.Created) {
      createdItems.push(configurationFileName);
    } else {
      existingItems.push(configurationFileName);
    }

    const createdCache = await createDefaultWorkspaceCacheFile();
    if (createdCache) {
      createdItems.push(workspaceCacheFileName);
    } else {
      existingItems.push(workspaceCacheFileName);
    }

    const summary = [
      createdItems.length > 0 ? `Created: ${createdItems.join(', ')}` : undefined,
      existingItems.length > 0 ? `Already existed: ${existingItems.join(', ')}` : undefined
    ].filter((item): item is string => !!item).join(' | ');
    const message = summary.length > 0 ? `PyDevice workspace initialized. ${summary}` : 'PyDevice workspace initialized.';
    vscode.window.showInformationMessage(message);
    logChannelOutput(message, true);
    await model.refresh(true);
  }));

  await model.refresh();
  await ensureNativeExplorerRoots(model);
};
