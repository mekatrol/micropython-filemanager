/**
 * Module overview:
 * Implements connect/disconnect/reconnect command flows and manages
 * runtime state for currently connected devices.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { logChannelOutput } from '../output-channel';
import { PyDeviceConnection, PyDeviceRuntimeInfo } from '../devices/py-device';
import { listSerialDevices } from '../utils/serial-port';
import { autoReconnectDevicesCacheKey, getWorkspaceCacheValue, setWorkspaceCacheValue } from '../utils/workspace-cache';
import { ConnectedPyDeviceRegistry, ConnectedPyDeviceState, ConnectedPyDeviceSnapshot } from '../devices/connected-py-device-registry';
import { ReconnectStateStore } from '../devices/reconnect-state-store';
import { toDeviceId } from '../devices/device-id';
import { getDeviceNames, loadConfiguration, updateDeviceName } from '../utils/configuration';
import {
  ConnectRow,
  ConnectStatus,
  resolveConnectStatus,
  toDeviceInfoSummary
} from './connect-state';
import { renderConnectHtml } from './connect-webview';

const reconnectDevicePathsStateKey = 'reconnectDevicePaths';
const lastKnownDevicePortByIdStateKey = 'lastKnownDevicePortById';
const defaultBaudRate = 115200;
const runtimeInfoConnectRetryAttempts = 3;
const runtimeInfoConnectRetryDelayMs = 250;
const runtimeInfoBackgroundRetryAttempts = 5;
const runtimeInfoBackgroundRetryDelayMs = 1000;
const runtimeInfoRecoveryProbeAttempts = 5;
const runtimeInfoRecoveryProbeDelayMs = 300;
const runtimeInfoRecoveryRebootAttempts = 2;
const runtimeInfoRecoveryRebootDelayMs = 500;
const connectionStateMonitorIntervalMs = 2000;
const recoveryConnectAttemptTimeoutMs = 25000;
const deviceDocumentScheme = 'pydevice-device';
const pydeviceDebugType = 'pydevice';

export type { ConnectedPyDeviceSnapshot } from '../devices/connected-py-device-registry';

const boardRegistry = new ConnectedPyDeviceRegistry();
const boardConnectionStateEmitter = new vscode.EventEmitter<boolean>();
const boardConnectionsChangedEmitter = new vscode.EventEmitter<ConnectedPyDeviceSnapshot[]>();
const boardRuntimeInfoChangedEmitter = new vscode.EventEmitter<PyDeviceRuntimeInfo | undefined>();
const boardExecutionStateChangedEmitter = new vscode.EventEmitter<ConnectedPyDeviceSnapshot[]>();

export const onBoardConnectionStateChanged = boardConnectionStateEmitter.event;
export const onBoardConnectionsChanged = boardConnectionsChangedEmitter.event;
export const onConnectedPyDeviceRuntimeInfoChanged = boardRuntimeInfoChangedEmitter.event;
export const onBoardExecutionStateChanged = boardExecutionStateChangedEmitter.event;

const reconnectStateStore = new ReconnectStateStore(
  <T>(key: string): T | undefined => getWorkspaceCacheValue<T>(key),
  async <T>(key: string, value: T): Promise<void> => setWorkspaceCacheValue(key, value),
  reconnectDevicePathsStateKey
);

const readLastKnownDevicePorts = (): Record<string, string> => {
  const raw = getWorkspaceCacheValue<unknown>(lastKnownDevicePortByIdStateKey);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }

  const entries = Object.entries(raw as Record<string, unknown>)
    .filter(([deviceId, port]) => typeof deviceId === 'string' && deviceId.length > 0 && typeof port === 'string' && port.length > 0)
    .sort((a, b) => a[0].localeCompare(b[0]));
  return Object.fromEntries(entries) as Record<string, string>;
};

const writeLastKnownDevicePorts = async (mapping: Record<string, string>): Promise<void> => {
  await setWorkspaceCacheValue(lastKnownDevicePortByIdStateKey, mapping);
};

const setLastKnownDevicePort = async (deviceId: string, devicePath: string): Promise<void> => {
  if (!deviceId || !devicePath) {
    return;
  }
  const current = readLastKnownDevicePorts();
  if (current[deviceId] === devicePath) {
    return;
  }
  const next = { ...current, [deviceId]: devicePath };
  await writeLastKnownDevicePorts(next);
};

const getDistinctConfiguredDeviceNames = (namesByDeviceId: Record<string, string>): Record<string, string> => {
  const distinct: Record<string, string> = {};
  const ownerByNameLower = new Map<string, string>();
  const duplicateDetails: Array<{ name: string; existingDeviceId: string; ignoredDeviceId: string }> = [];

  for (const deviceId of Object.keys(namesByDeviceId).sort((a, b) => a.localeCompare(b))) {
    const rawName = namesByDeviceId[deviceId];
    const name = rawName?.trim();
    if (!name) {
      continue;
    }

    const key = name.toLocaleLowerCase();
    const existingOwner = ownerByNameLower.get(key);
    if (existingOwner && existingOwner !== deviceId) {
      duplicateDetails.push({ name, existingDeviceId: existingOwner, ignoredDeviceId: deviceId });
      continue;
    }

    ownerByNameLower.set(key, deviceId);
    distinct[deviceId] = name;
  }

  if (duplicateDetails.length > 0) {
    const summary = duplicateDetails
      .map((item) => `"${item.name}" kept for ${item.existingDeviceId}, ignored for ${item.ignoredDeviceId}`)
      .join('; ');
    const message = `Duplicate device names detected in .pydevice/config.json. ${summary}`;
    logChannelOutput(message, true);
    void vscode.window.showWarningMessage(message);
  }

  return distinct;
};

const wait = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
};

const getConnectedPyDeviceStateByPortPath = (devicePath: string): ConnectedPyDeviceState | undefined =>
  boardRegistry.getByPortPath(devicePath);

const readBoardRuntimeInfoWithRetries = async (
  board: PyDeviceConnection,
  devicePath: string,
  attempts: number,
  delayMs: number
): Promise<PyDeviceRuntimeInfo | undefined> => {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await board.getBoardRuntimeInfo();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await wait(delayMs);
      }
    }
  }

  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  const message = `Connected, but failed to read board runtime info for ${devicePath} after ${attempts} attempt(s): ${reason}`;
  logChannelOutput(message, true);
  void vscode.window.showWarningMessage(message);
  return undefined;
};

const readBoardRuntimeInfoWithRecovery = async (
  board: PyDeviceConnection,
  devicePath: string
): Promise<PyDeviceRuntimeInfo | undefined> => {
  let lastError: unknown;

  // Probe-first: this path repeatedly issues Ctrl-C and enters raw REPL without soft reboot.
  for (let attempt = 1; attempt <= runtimeInfoRecoveryProbeAttempts; attempt += 1) {
    try {
      return await board.probeBoardRuntimeInfo(3500);
    } catch (error) {
      lastError = error;
      if (attempt < runtimeInfoRecoveryProbeAttempts) {
        await wait(runtimeInfoRecoveryProbeDelayMs);
      }
    }
  }

  // Soft-reboot fallback for boards that only recover after a reset.
  for (let attempt = 1; attempt <= runtimeInfoRecoveryRebootAttempts; attempt += 1) {
    try {
      return await board.getBoardRuntimeInfo(9000);
    } catch (error) {
      lastError = error;
      if (attempt < runtimeInfoRecoveryRebootAttempts) {
        await wait(runtimeInfoRecoveryRebootDelayMs);
      }
    }
  }

  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  const message = `Recovery connect: failed to read board runtime info for ${devicePath} after ${runtimeInfoRecoveryProbeAttempts + runtimeInfoRecoveryRebootAttempts} attempt(s): ${reason}`;
  logChannelOutput(message, true);
  void vscode.window.showWarningMessage(message);
  return undefined;
};

const parseDeviceIdFromDeviceUri = (uri: vscode.Uri): string | undefined => {
  if (uri.scheme !== deviceDocumentScheme) {
    return undefined;
  }

  const path = uri.path.replace(/^\/+/, '');
  if (!path) {
    return undefined;
  }

  const [deviceFolder] = path.split('/').filter((segment) => segment.length > 0);
  if (!deviceFolder) {
    return undefined;
  }

  try {
    return decodeURIComponent(deviceFolder);
  } catch {
    return deviceFolder;
  }
};

const getDirtyDeviceDocuments = (deviceId?: string): vscode.TextDocument[] => {
  return vscode.workspace.textDocuments.filter((document) => {
    if (document.uri.scheme !== deviceDocumentScheme || !document.isDirty) {
      return false;
    }

    if (!deviceId) {
      return true;
    }

    return parseDeviceIdFromDeviceUri(document.uri) === deviceId;
  });
};

const saveDirtyDeviceDocumentsBeforeDisconnect = async (deviceId?: string): Promise<boolean> => {
  const dirtyDocuments = getDirtyDeviceDocuments(deviceId);
  if (dirtyDocuments.length === 0) {
    return true;
  }

  const action = await vscode.window.showWarningMessage(
    `You have ${dirtyDocuments.length} unsaved device file(s). Save all to device before disconnecting?`,
    { modal: true },
    'Save & Disconnect'
  );

  if (action !== 'Save & Disconnect') {
    logChannelOutput('Disconnect cancelled by user: unsaved device files were not saved.', true);
    return false;
  }

  for (const document of dirtyDocuments) {
    const saved = await document.save();
    if (!saved || document.isDirty) {
      const msg = `Could not save device file before disconnect: ${document.uri.path}`;
      vscode.window.showErrorMessage(msg);
      logChannelOutput(msg, true);
      return false;
    }
  }

  return true;
};

const getOpenDeviceTabs = (deviceId?: string): vscode.Tab[] => {
  const tabs: vscode.Tab[] = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (!(tab.input instanceof vscode.TabInputText)) {
        continue;
      }

      if (tab.input.uri.scheme !== deviceDocumentScheme) {
        continue;
      }

      if (deviceId) {
        const tabDeviceId = parseDeviceIdFromDeviceUri(tab.input.uri);
        if (tabDeviceId !== deviceId) {
          continue;
        }
      }

      tabs.push(tab);
    }
  }

  return tabs;
};

const closeOpenDeviceTabsAfterDisconnect = async (deviceId?: string): Promise<void> => {
  const deviceTabs = getOpenDeviceTabs(deviceId);
  if (deviceTabs.length === 0) {
    return;
  }

  const closed = await vscode.window.tabGroups.close(deviceTabs, true);
  if (!closed) {
    logChannelOutput('Disconnected, but some device tabs could not be closed.', true);
  }
};

const pruneStaleConnectedDevices = async (
  knownPorts?: Awaited<ReturnType<typeof listSerialDevices>>
): Promise<void> => {
  let activePorts = knownPorts;
  if (!activePorts) {
    try {
      activePorts = await listSerialDevices();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logChannelOutput(`Skipping stale connection pruning: unable to list serial devices. ${reason}`, false);
      return;
    }
  }

  const currentPortPaths = new Set(activePorts.map((port) => port.path));
  const staleSnapshots = boardRegistry.getSnapshots().filter((snapshot) => !currentPortPaths.has(snapshot.devicePath));
  if (staleSnapshots.length === 0) {
    return;
  }

  for (const snapshot of staleSnapshots) {
    const removed = boardRegistry.remove(snapshot.deviceId);
    if (!removed) {
      continue;
    }
    void removed.board.close().catch(() => {
      // Ignore close failures for already-disconnected/unplugged devices.
    });
    logChannelOutput(
      `Dropped stale connection state for ${snapshot.deviceId} on ${snapshot.devicePath} after serial port disappeared.`,
      false
    );
  }

  notifyStateChanged();
};

const notifyStateChanged = (): void => {
  const snapshots = boardRegistry.getSnapshots();
  const connected = snapshots.length > 0;
  void vscode.commands.executeCommand('setContext', 'mekatrol.pydevice.boardConnected', connected);
  void vscode.commands.executeCommand('setContext', 'mekatrol.pydevice.connectedPyDeviceCount', snapshots.length);
  boardConnectionStateEmitter.fire(connected);
  boardConnectionsChangedEmitter.fire(snapshots);
  boardRuntimeInfoChangedEmitter.fire(getConnectedPyDeviceRuntimeInfo());
  boardExecutionStateChangedEmitter.fire(snapshots);
};

export const isBoardConnected = (): boolean => boardRegistry.isConnected();

export const getConnectedPyDevice = (deviceId?: string): PyDeviceConnection | undefined => {
  return boardRegistry.getByDeviceId(deviceId)?.board;
};

export const getConnectedPyDeviceByPortPath = (devicePath: string): PyDeviceConnection | undefined => {
  return getConnectedPyDeviceStateByPortPath(devicePath)?.board;
};

export const getConnectedPyDeviceRuntimeInfo = (deviceId?: string): PyDeviceRuntimeInfo | undefined => {
  return boardRegistry.getByDeviceId(deviceId)?.runtimeInfo;
};

export const getConnectedPyDevices = (): ConnectedPyDeviceSnapshot[] => boardRegistry.getSnapshots();

export const getConnectedDeviceIds = (): string[] => boardRegistry.getConnectedDeviceIds();

export const getDeviceIdForPortPath = (devicePath: string): string | undefined => {
  return getConnectedPyDeviceStateByPortPath(devicePath)?.deviceId;
};

export const beginBoardExecution = (deviceId: string): void => {
  if (!boardRegistry.beginExecution(deviceId)) {
    return;
  }
  notifyStateChanged();
};

export const endBoardExecution = (deviceId: string): void => {
  if (!boardRegistry.endExecution(deviceId)) {
    return;
  }
  notifyStateChanged();
};

export const isBoardExecuting = (deviceId: string): boolean => {
  return boardRegistry.isExecuting(deviceId);
};

const connectBoardForPath = async (
  devicePath: string,
  baudRate: number,
  showMessages: boolean,
  recoveryMode: boolean = false
): Promise<ConnectedPyDeviceState | undefined> => {
  const existingForPath = getConnectedPyDeviceStateByPortPath(devicePath);
  if (existingForPath) {
    if (showMessages) {
      const msg = `Device already connected: ${existingForPath.deviceId} on ${devicePath}.`;
      vscode.window.showInformationMessage(msg);
      logChannelOutput(msg, true);
    }
    return existingForPath;
  }

  const board = new PyDeviceConnection(devicePath, baudRate, showMessages);
  await board.open();

  const runtimeInfo = recoveryMode
    ? await readBoardRuntimeInfoWithRecovery(board, devicePath)
    : await readBoardRuntimeInfoWithRetries(
      board,
      devicePath,
      runtimeInfoConnectRetryAttempts,
      runtimeInfoConnectRetryDelayMs
    );

  const deviceId = toDeviceId(devicePath, runtimeInfo);
  if (boardRegistry.hasDeviceId(deviceId)) {
    await board.close();
    throw new Error(`A board with device ID ${deviceId} is already connected.`);
  }

  const state: ConnectedPyDeviceState = {
    deviceId,
    board,
    runtimeInfo,
    executionCount: 0
  };

  boardRegistry.add(state);
  await reconnectStateStore.addReconnectDevicePath(board.device);
  await setLastKnownDevicePort(state.deviceId, board.device);
  notifyStateChanged();

  if (!runtimeInfo) {
    void (async () => {
      let lastError: unknown;
      for (let attempt = 1; attempt <= runtimeInfoBackgroundRetryAttempts; attempt += 1) {
        await wait(runtimeInfoBackgroundRetryDelayMs);

        const currentState = boardRegistry.getByDeviceId(state.deviceId);
        if (!currentState || currentState !== state) {
          return;
        }

        try {
          const refreshedRuntimeInfo = await state.board.getBoardRuntimeInfo();
          boardRegistry.setRuntimeInfo(state.deviceId, refreshedRuntimeInfo);
          notifyStateChanged();
          logChannelOutput(`Runtime info recovered for ${state.deviceId} on attempt ${attempt}.`, false);
          return;
        } catch (error) {
          lastError = error;
        }
      }

      const reason = lastError instanceof Error ? lastError.message : String(lastError);
      const message = `Runtime info remained unavailable for ${state.deviceId} after ${runtimeInfoBackgroundRetryAttempts} background attempt(s): ${reason}`;
      logChannelOutput(message, true);
      void vscode.window.showWarningMessage(message);
    })();
  }

  if (showMessages) {
    const msg = `Connected to board ${deviceId} on ${devicePath} @ ${baudRate}.`;
    vscode.window.showInformationMessage(msg);
    logChannelOutput(msg, true);
  }

  return state;
};

export const closeConnectedPyDeviceByDeviceId = async (
  deviceId: string,
  showSuccessMessage = true,
  preserveReconnectState = false,
  promptToSaveDirtyDeviceFiles = true,
  closeDeviceTabsAfterDisconnect = true
): Promise<boolean> => {
  const state = boardRegistry.getByDeviceId(deviceId);
  if (!state) {
    if (showSuccessMessage) {
      const msg = `No active board connection found for ${deviceId}.`;
      vscode.window.showInformationMessage(msg);
      logChannelOutput(msg, true);
    }
    return true;
  }

  if (promptToSaveDirtyDeviceFiles) {
    const canClose = await saveDirtyDeviceDocumentsBeforeDisconnect(deviceId);
    if (!canClose) {
      return false;
    }
  }

  try {
    await state.board.close();
    boardRegistry.remove(deviceId);
    if (!preserveReconnectState) {
      await reconnectStateStore.removeReconnectDevicePath(state.board.device);
    }

    notifyStateChanged();

    if (closeDeviceTabsAfterDisconnect) {
      await closeOpenDeviceTabsAfterDisconnect(deviceId);
    }

    if (showSuccessMessage) {
      const msg = `Board connection closed for ${deviceId}.`;
      vscode.window.showInformationMessage(msg);
      logChannelOutput(msg, true);
    } else {
      logChannelOutput(`Board connection closed for ${deviceId} during extension shutdown.`, false);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const msg = `Failed to close board connection for ${deviceId}. ${reason}`;
    logChannelOutput(msg, true);
    return false;
  }

  return true;
};

export const closeConnectedPyDevice = async (
  showSuccessMessage = true,
  preserveReconnectState = false,
  promptToSaveDirtyDeviceFiles = true,
  closeDeviceTabsAfterDisconnect = true
): Promise<boolean> => {
  const active = boardRegistry.getByDeviceId();
  if (!active) {
    if (showSuccessMessage) {
      const msg = 'No active board connection to close.';
      vscode.window.showInformationMessage(msg);
      logChannelOutput(msg, true);
    }
    return true;
  }

  return closeConnectedPyDeviceByDeviceId(
    active.deviceId,
    showSuccessMessage,
    preserveReconnectState,
    promptToSaveDirtyDeviceFiles,
    closeDeviceTabsAfterDisconnect
  );
};

export const closeAllConnectedPyDevices = async (
  showSuccessMessage = false,
  preserveReconnectState = false,
  promptToSaveDirtyDeviceFiles = false,
  closeDeviceTabsAfterDisconnect = false
): Promise<boolean> => {
  const deviceIds = getConnectedDeviceIds();
  for (const deviceId of deviceIds) {
    const closed = await closeConnectedPyDeviceByDeviceId(
      deviceId,
      showSuccessMessage,
      preserveReconnectState,
      promptToSaveDirtyDeviceFiles,
      closeDeviceTabsAfterDisconnect
    );
    if (!closed) {
      return false;
    }
  }

  if (!preserveReconnectState) {
    await reconnectStateStore.writeReconnectDevicePaths([]);
  }

  return true;
};

const pickConnectedDeviceId = async (placeHolder: string): Promise<string | undefined> => {
  const snapshots = boardRegistry.getSnapshots();
  if (snapshots.length === 0) {
    return undefined;
  }

  if (snapshots.length === 1) {
    return snapshots[0].deviceId;
  }

  const selected = await vscode.window.showQuickPick(
    snapshots.map((item) => ({
      label: item.deviceId,
      description: `${item.devicePath} @ ${item.baudRate}`
    })),
    {
      placeHolder,
      canPickMany: false,
      ignoreFocusOut: true
    }
  );

  return selected?.label;
};

const probeRecoveryDeviceId = async (devicePath: string): Promise<string | undefined> => {
  const board = new PyDeviceConnection(devicePath, defaultBaudRate, false);
  try {
    await board.open();
    const runtimeInfo = await board.probeBoardRuntimeInfo(1800);
    return toDeviceId(devicePath, runtimeInfo);
  } catch {
    return undefined;
  } finally {
    try {
      await board.close();
    } catch {
      // Ignore close failures during non-fatal probing.
    }
  }
};

const pickSerialPortToConnect = async (
  onlyUnconnected: boolean = false,
  recoveryMode: boolean = false
): Promise<string | undefined> => {
  const ports = await listSerialDevices();
  if (ports.length === 0) {
    const msg = 'No serial devices found.';
    vscode.window.showWarningMessage(msg);
    logChannelOutput(msg, true);
    return undefined;
  }

  const connectedPaths = new Set(boardRegistry.getSnapshots().map((item) => item.devicePath));
  const candidatePorts = onlyUnconnected
    ? ports.filter((port) => !connectedPaths.has(port.path))
    : ports;

  if (candidatePorts.length === 0) {
    const msg = 'No additional serial devices available to connect.';
    vscode.window.showWarningMessage(msg);
    logChannelOutput(msg, true);
    return undefined;
  }

  let configuredDeviceNames: Record<string, string> = {};
  if (recoveryMode) {
    const configuration = await loadConfiguration();
    configuredDeviceNames = getDistinctConfiguredDeviceNames(getDeviceNames(configuration));
  }

  const connectedSnapshots = boardRegistry.getSnapshots();
  const connectedDeviceIdByPath = new Map(connectedSnapshots.map((snapshot) => [snapshot.devicePath, snapshot.deviceId]));
  const resolveRecoveryDeviceId = async (devicePath: string): Promise<string | undefined> => {
    const connectedDeviceId = connectedDeviceIdByPath.get(devicePath);
    if (connectedDeviceId) {
      return connectedDeviceId;
    }

    if (!recoveryMode) {
      return undefined;
    }

    return probeRecoveryDeviceId(devicePath);
  };

  const items = await Promise.all(candidatePorts.map(async (port) => {
    const details = [port.manufacturer, `VID:${port.vendorId}`, `PID:${port.productId}`].filter(Boolean).join(' | ');
    const alreadyConnected = connectedPaths.has(port.path);
    const serialPortName = path.basename(port.path);
    const resolvedDeviceId = await resolveRecoveryDeviceId(port.path);
    const fallbackDeviceId = toDeviceId(port.path);
    const deviceId = resolvedDeviceId ?? fallbackDeviceId;
    const deviceName = configuredDeviceNames[deviceId];
    const recoveryLabel = deviceName ? `${deviceName} (${serialPortName})` : `${deviceId} (${serialPortName})`;
    return {
      label: recoveryMode ? recoveryLabel : port.path,
      description: alreadyConnected ? `already connected${details ? ` | ${details}` : ''}` : details,
      picked: false,
      devicePath: port.path
    };
  }));

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select a serial port to connect',
    canPickMany: false,
    ignoreFocusOut: true
  });

  return selected?.devicePath;
};

export const initConnectBoardCommand = (context: vscode.ExtensionContext) => {
  const command = vscode.commands.registerCommand('mekatrol.pydevice.connectboard', async (arg?: unknown) => {
    const forcePickPort = Boolean(
      arg === true
      || (typeof arg === 'object' && arg && 'forcePickPort' in arg && (arg as { forcePickPort?: unknown }).forcePickPort === true)
    );
    const recoveryMode = Boolean(
      typeof arg === 'object' && arg && 'recoveryMode' in arg && (arg as { recoveryMode?: unknown }).recoveryMode === true
    );
    let devicePath = typeof arg === 'string'
      ? arg
      : typeof arg === 'object' && arg && 'devicePath' in arg && typeof (arg as { devicePath?: unknown }).devicePath === 'string'
        ? (arg as { devicePath: string }).devicePath
        : undefined;
    const baudRate = defaultBaudRate;

    if (forcePickPort || !devicePath) {
      try {
        devicePath = await pickSerialPortToConnect(forcePickPort, recoveryMode);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const msg = `Unable to list serial ports. ${reason}`;
        vscode.window.showErrorMessage(msg);
        logChannelOutput(msg, true);
        return;
      }
    }

    if (!devicePath) {
      return;
    }

    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
      const workspaceWarning = 'No workspace folder is open. Device can connect, but it will not appear in PyDevice Explorer until you open a workspace folder.';
      vscode.window.showWarningMessage(workspaceWarning);
      logChannelOutput(workspaceWarning, true);
    }

    if (getConnectedPyDeviceByPortPath(devicePath)) {
      const msg = `Device on ${devicePath} is already connected. Choose another serial port.`;
      vscode.window.showWarningMessage(msg);
      logChannelOutput(msg, true);
      return;
    }

    try {
      await connectBoardForPath(devicePath, baudRate, true, recoveryMode);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const msg = `Failed to connect to board on ${devicePath} @ ${baudRate}${recoveryMode ? ' (recovery mode)' : ''}. ${reason}`;
      vscode.window.showErrorMessage(msg);
      logChannelOutput(msg, true);
    }
  });

  context.subscriptions.push(command);
  notifyStateChanged();
};

export const initRecoveryConnectCommand = (context: vscode.ExtensionContext) => {
  const command = vscode.commands.registerCommand('mekatrol.pydevice.connectboardrecovery', async (arg?: unknown) => {
    const devicePath = typeof arg === 'string'
      ? arg
      : typeof arg === 'object' && arg && 'devicePath' in arg && typeof (arg as { devicePath?: unknown }).devicePath === 'string'
        ? (arg as { devicePath: string }).devicePath
        : undefined;

    if (devicePath) {
      await vscode.commands.executeCommand('mekatrol.pydevice.connectboard', {
        forcePickPort: false,
        devicePath,
        recoveryMode: true
      });
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

    const configuration = await loadConfiguration();
    let configuredDeviceNames = getDistinctConfiguredDeviceNames(getDeviceNames(configuration));
    let configuredDeviceIds = Object.keys(configuration.devices ?? {}).sort((a, b) => a.localeCompare(b));
    const configuredDeviceIdSet = new Set(configuredDeviceIds);
    const lastKnownDevicePortById = readLastKnownDevicePorts();
    const updateLastKnownDevicePort = async (deviceId: string, serialPortPath: string): Promise<void> => {
      if (!deviceId || !serialPortPath) {
        return;
      }
      if (lastKnownDevicePortById[deviceId] === serialPortPath) {
        return;
      }
      lastKnownDevicePortById[deviceId] = serialPortPath;
      await writeLastKnownDevicePorts(lastKnownDevicePortById);
    };
    const refreshConfiguredMappings = async (): Promise<void> => {
      const nextConfig = await loadConfiguration();
      configuredDeviceNames = getDistinctConfiguredDeviceNames(getDeviceNames(nextConfig));
      configuredDeviceIds = Object.keys(nextConfig.devices ?? {}).sort((a, b) => a.localeCompare(b));
      configuredDeviceIdSet.clear();
      for (const deviceId of configuredDeviceIds) {
        configuredDeviceIdSet.add(deviceId);
      }
    };

    const panel = vscode.window.createWebviewPanel(
      'pydevice.deviceConnect',
      'Device Connect',
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true }
    );
    panel.webview.html = renderConnectHtml([], recoveryConnectAttemptTimeoutMs);

    let rowsById = new Map<string, ConnectRow>();
    const resolvedDeviceIdByPath = new Map<string, string>();
    const mismatchObservationByPort = new Map<string, { deviceId: string; count: number }>();
    const probingPaths = new Set<string>();
    const connectingPaths = new Set<string>();
    const wasConnectedByPath = new Map<string, boolean>();
    const wasPresentByPath = new Map<string, boolean>();
    let disposed = false;
    let reconcileInProgress = false;
    let reconcilePending = false;

    panel.onDidDispose(() => {
      disposed = true;
    });

    const pushRows = (): void => {
      const sortedRows = [...rowsById.values()].sort((a, b) => {
        const aKey = (a.deviceName || a.deviceId || a.serialPortName).toLocaleLowerCase();
        const bKey = (b.deviceName || b.deviceId || b.serialPortName).toLocaleLowerCase();
        return aKey.localeCompare(bKey);
      });
      void panel.webview.postMessage({ type: 'replaceRows', rows: sortedRows });
    };

    const updateRow = (row: ConnectRow): void => {
      void panel.webview.postMessage({ type: 'updateRow', row });
    };

    const reconcileRows = async (knownPorts?: Awaited<ReturnType<typeof listSerialDevices>>): Promise<void> => {
      if (disposed) {
        return;
      }
      if (reconcileInProgress) {
        reconcilePending = true;
        return;
      }
      reconcileInProgress = true;

      try {
        let activePorts = knownPorts;
        if (!activePorts) {
          try {
            activePorts = await listSerialDevices();
          } catch {
            activePorts = [];
          }
        }
        const currentPortPaths = new Set(activePorts.map((port) => port.path));

        await pruneStaleConnectedDevices(activePorts);

        for (const devicePath of [...resolvedDeviceIdByPath.keys()]) {
          if (!currentPortPaths.has(devicePath)) {
            resolvedDeviceIdByPath.delete(devicePath);
            mismatchObservationByPort.delete(devicePath);
            wasConnectedByPath.delete(devicePath);
            wasPresentByPath.delete(devicePath);
          }
        }

        const nextRows = new Map<string, ConnectRow>();
        const seenConfiguredDeviceIds = new Set<string>();
        const claimedConfiguredIdByPort = new Map<string, string>();

        for (const port of activePorts) {
          const presentBefore = wasPresentByPath.get(port.path) ?? false;
          const presentNow = true;
          if (!presentBefore && presentNow) {
            // Port path has (re)appeared; require a fresh ID probe for this session.
            resolvedDeviceIdByPath.delete(port.path);
          }
          wasPresentByPath.set(port.path, true);

          const connectedNow = !!getConnectedPyDeviceStateByPortPath(port.path);
          const connectedBefore = wasConnectedByPath.get(port.path) ?? false;
          if (connectedBefore && !connectedNow) {
            // This path disconnected; require a fresh probe before trusting identity again.
            resolvedDeviceIdByPath.delete(port.path);
          }
          wasConnectedByPath.set(port.path, connectedNow);

          const connectedState = getConnectedPyDeviceStateByPortPath(port.path);
          const connectedDeviceId = connectedState?.deviceId;
          if (connectedDeviceId && configuredDeviceIdSet.has(connectedDeviceId)) {
            claimedConfiguredIdByPort.set(port.path, connectedDeviceId);
            seenConfiguredDeviceIds.add(connectedDeviceId);
            continue;
          }

          const cachedCandidate = configuredDeviceIds.find((deviceId) =>
            !seenConfiguredDeviceIds.has(deviceId)
            // If a configured device is already connected, do not let another
            // unresolved port claim that same configured identity row.
            && !boardRegistry.getByDeviceId(deviceId)
            && lastKnownDevicePortById[deviceId] === port.path
          );
          if (cachedCandidate) {
            claimedConfiguredIdByPort.set(port.path, cachedCandidate);
            seenConfiguredDeviceIds.add(cachedCandidate);
          }
        }

        for (const port of activePorts) {
          const claimedConfiguredId = claimedConfiguredIdByPort.get(port.path);
          const initialRowId = claimedConfiguredId ? `config:${claimedConfiguredId}` : `port:${port.path}`;
          let rowId = initialRowId;
          let existing = rowsById.get(rowId);
          const serialPortName = path.basename(port.path);
          const connectedState = getConnectedPyDeviceStateByPortPath(port.path);
          const connectedDeviceId = connectedState?.deviceId;
          if (connectedDeviceId) {
            resolvedDeviceIdByPath.set(port.path, connectedDeviceId);
            mismatchObservationByPort.delete(port.path);
            void updateLastKnownDevicePort(connectedDeviceId, port.path);
          }
          const resolvedDeviceId = connectedDeviceId ?? resolvedDeviceIdByPath.get(port.path);
          let deviceId = claimedConfiguredId ?? resolvedDeviceId ?? toDeviceId(port.path);

          if (
            claimedConfiguredId
            && resolvedDeviceId
            && resolvedDeviceId !== claimedConfiguredId
            && !connectedState
          ) {
            const previous = mismatchObservationByPort.get(port.path);
            const count = previous && previous.deviceId === resolvedDeviceId
              ? previous.count + 1
              : 1;
            mismatchObservationByPort.set(port.path, { deviceId: resolvedDeviceId, count });

            if (count >= 2) {
              // Port appeared where a configured device was last seen, but stable probed ID does
              // not match. Keep configured row as not connected and create a distinct port row.
              rowId = `port:${port.path}`;
              existing = rowsById.get(rowId);
              deviceId = resolvedDeviceId;
              seenConfiguredDeviceIds.delete(claimedConfiguredId);
            }
          } else {
            mismatchObservationByPort.delete(port.path);
          }

          if (configuredDeviceIdSet.has(deviceId)) {
            seenConfiguredDeviceIds.add(deviceId);
          }

          const status = resolveConnectStatus({
            isConnected: !!connectedState,
            isConnecting: connectingPaths.has(port.path),
            hasError: existing?.status === ConnectStatus.Error,
            hasResolvedDeviceId: !!resolvedDeviceId,
            // We already have a configured identity + remembered port match.
            // Show this as connectable instead of indefinite "Fetching ID...".
            hasClaimedConfiguredId: !!claimedConfiguredId
          });

          const row: ConnectRow = {
            id: rowId,
            devicePath: port.path,
            serialPortName,
            deviceId,
            deviceName: configuredDeviceNames[deviceId] ?? '',
            status,
            deviceInfo: toDeviceInfoSummary(connectedState?.runtimeInfo),
            errorText: status === ConnectStatus.Error ? existing?.errorText : undefined,
            details: [port.manufacturer, `VID:${port.vendorId}`, `PID:${port.productId}`].filter(Boolean).join(' | ')
          };
          nextRows.set(rowId, row);

          const needsReprobe = !connectedState
            && !probingPaths.has(port.path)
            && !connectingPaths.has(port.path)
            // Re-probe only while unresolved; resolved IDs are invalidated on
            // port reappearance/disconnect earlier in reconcileRows.
            && !resolvedDeviceId
            // Claimed configured rows are verified at connect time.
            && !claimedConfiguredId;
          if (needsReprobe) {
            probingPaths.add(port.path);
            void (async () => {
              const probedDeviceId = await probeRecoveryDeviceId(port.path);
              probingPaths.delete(port.path);
              if (disposed) {
                return;
              }
              const nextDeviceId = probedDeviceId ?? toDeviceId(port.path);
              resolvedDeviceIdByPath.set(port.path, nextDeviceId);
              if (probedDeviceId) {
                void updateLastKnownDevicePort(probedDeviceId, port.path);
              }
              await reconcileRows();
            })();
          }
        }

        for (const configuredDeviceId of configuredDeviceIds) {
          if (seenConfiguredDeviceIds.has(configuredDeviceId)) {
            continue;
          }
          const connectedState = boardRegistry.getByDeviceId(configuredDeviceId);
          const connectedPath = connectedState?.board.device;
          const isPortPresent = !!connectedPath && currentPortPaths.has(connectedPath);
          const rememberedPort = lastKnownDevicePortById[configuredDeviceId];
          const serialPortPath = (isPortPresent ? connectedPath : undefined) ?? rememberedPort ?? '';
          const serialPortName = serialPortPath ? path.basename(serialPortPath) : '';
          const rowId = `config:${configuredDeviceId}`;
          nextRows.set(rowId, {
            id: rowId,
            devicePath: serialPortPath,
            serialPortName,
            deviceId: configuredDeviceId,
            deviceName: configuredDeviceNames[configuredDeviceId] ?? '',
            deviceInfo: toDeviceInfoSummary(connectedState?.runtimeInfo),
            status: connectedState && isPortPresent ? ConnectStatus.Connected : ConnectStatus.NotConnected
          });
        }

        rowsById = nextRows;
        pushRows();
      } finally {
        reconcileInProgress = false;
        if (reconcilePending) {
          reconcilePending = false;
          void reconcileRows();
        }
      }
    };

    const connectRow = async (row: ConnectRow): Promise<void> => {
      const rowId = row.id;
      const getLatestRow = (): ConnectRow => rowsById.get(rowId) ?? row;

      if (!row.devicePath) {
        return;
      }
      if (connectingPaths.has(row.devicePath)) {
        return;
      }
      const currentlyConnected = getConnectedPyDeviceByPortPath(row.devicePath);
      if (currentlyConnected) {
        const latestRow = getLatestRow();
        latestRow.status = ConnectStatus.Connected;
        updateRow(latestRow);
        return;
      }

      connectingPaths.add(row.devicePath);
      {
        const latestRow = getLatestRow();
        latestRow.status = ConnectStatus.Connecting;
        latestRow.errorText = undefined;
        updateRow(latestRow);
      }

      try {
        const initialRow = getLatestRow();
        if (initialRow.id.startsWith('config:')) {
          const probedId = await probeRecoveryDeviceId(initialRow.devicePath);
          if (probedId && probedId !== initialRow.deviceId) {
            resolvedDeviceIdByPath.set(initialRow.devicePath, probedId);
            const latestRow = getLatestRow();
            latestRow.status = ConnectStatus.Ready;
            latestRow.errorText = undefined;
            await reconcileRows();
            return;
          }
        }

        let state: ConnectedPyDeviceState | undefined;
        try {
          state = await withTimeout(
            connectBoardForPath(initialRow.devicePath, defaultBaudRate, true, true),
            recoveryConnectAttemptTimeoutMs,
            `Connect attempt for ${initialRow.devicePath}`
          );
        } catch (error) {
          const message = error instanceof Error ? error.message.toLocaleLowerCase() : String(error).toLocaleLowerCase();
          const transientLock = message.includes('cannot lock port') || message.includes('resource temporarily unavailable');
          if (!transientLock) {
            throw error;
          }
          await wait(350);
          state = await withTimeout(
            connectBoardForPath(initialRow.devicePath, defaultBaudRate, true, true),
            recoveryConnectAttemptTimeoutMs,
            `Retry connect attempt for ${initialRow.devicePath}`
          );
        }
        const latestRow = getLatestRow();
        const nextDeviceId = state?.deviceId ?? latestRow.deviceId;
        resolvedDeviceIdByPath.set(latestRow.devicePath, nextDeviceId);
        void updateLastKnownDevicePort(nextDeviceId, latestRow.devicePath);
        await reconcileRows();
      } catch (error) {
        const latestRow = getLatestRow();
        latestRow.status = ConnectStatus.Error;
        const rawMessage = error instanceof Error ? error.message : String(error);
        latestRow.errorText = rawMessage.includes('timed out after')
          ? 'Connect timed out. Device may not be running MicroPython/raw REPL.'
          : rawMessage;
        updateRow(latestRow);
      } finally {
        connectingPaths.delete(row.devicePath);
      }
    };

    const connectAll = async (): Promise<void> => {
      const candidates = [...rowsById.values()].filter(
        (row) => row.devicePath.length > 0
          && (row.status === ConnectStatus.Ready || row.status === ConnectStatus.Error)
      );
      for (const row of candidates) {
        // Sequential connect to avoid multiple simultaneous serial handshake collisions.
        await connectRow(row);
      }
    };

    panel.webview.onDidReceiveMessage((message: unknown) => {
      if (!message || typeof message !== 'object') {
        return;
      }
      const typed = message as { type?: string; rowId?: string };
      if (typed.type === 'close') {
        panel.dispose();
        return;
      }
      if (typed.type === 'connectAll') {
        void connectAll();
        return;
      }
      if (typed.type === 'connect' && typeof typed.rowId === 'string') {
        const row = rowsById.get(typed.rowId);
        if (!row) {
          return;
        }
        void connectRow(row);
        return;
      }
      if (typed.type === 'setName' && typeof typed.rowId === 'string') {
        const row = rowsById.get(typed.rowId);
        if (!row || !row.deviceId) {
          return;
        }
        void (async () => {
          await refreshConfiguredMappings();
          const suggested = row.deviceName || '';
          const name = await vscode.window.showInputBox({
            title: 'Set Device Name',
            prompt: `Set device name for ${row.deviceId}`,
            value: suggested,
            ignoreFocusOut: true,
            validateInput: (value) => {
              const trimmed = value.trim();
              if (!trimmed) {
                return 'Device name is required.';
              }
              const key = trimmed.toLocaleLowerCase();
              const duplicate = Object.entries(configuredDeviceNames).find(
                ([deviceId, configuredName]) => (
                  deviceId !== row.deviceId
                  && configuredName.trim().toLocaleLowerCase() === key
                )
              );
              if (duplicate) {
                return `Device name "${trimmed}" is already used by ${duplicate[0]}.`;
              }
              return undefined;
            }
          });
          if (!name) {
            return;
          }

          try {
            await updateDeviceName(row.deviceId, name);
            await refreshConfiguredMappings();
            await reconcileRows();
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            const msg = `Failed to set device name for ${row.deviceId}. ${reason}`;
            vscode.window.showErrorMessage(msg);
            logChannelOutput(msg, true);
          }
        })();
      }
    });

    const monitorTimer = setInterval(() => {
      if (disposed) {
        clearInterval(monitorTimer);
        return;
      }
      void reconcileRows();
    }, connectionStateMonitorIntervalMs);
    const boardChangeDisposable = onBoardConnectionsChanged(() => {
      if (disposed) {
        return;
      }
      void reconcileRows();
    });
    panel.onDidDispose(() => {
      clearInterval(monitorTimer);
      boardChangeDisposable.dispose();
    });
    await reconcileRows(ports);
  });

  context.subscriptions.push(command);
};

export const initDisconnectBoardCommand = (context: vscode.ExtensionContext) => {
  const command = vscode.commands.registerCommand('mekatrol.pydevice.disconnectboard', async (arg?: unknown) => {
    const targetDeviceId = typeof arg === 'string'
      ? arg
      : typeof arg === 'object' && arg && 'deviceId' in arg && typeof (arg as { deviceId?: unknown }).deviceId === 'string'
        ? (arg as { deviceId: string }).deviceId
        : await pickConnectedDeviceId('Select a connected device to disconnect');

    if (!targetDeviceId) {
      return;
    }

    await closeConnectedPyDeviceByDeviceId(targetDeviceId, true);
  });

  context.subscriptions.push(command);
};

export const initToggleBoardConnectionCommand = (context: vscode.ExtensionContext) => {
  const command = vscode.commands.registerCommand('mekatrol.pydevice.toggleboardconnection', async () => {
    if (isBoardConnected()) {
      const action = await vscode.window.showQuickPick(
        [
          {
            label: 'Connect another board',
            description: 'Select a serial port and add another active connection'
          },
          {
            label: 'Disconnect a board',
            description: 'Choose one connected board to disconnect'
          }
        ],
        {
          placeHolder: 'Manage connected boards',
          canPickMany: false,
          ignoreFocusOut: true
        }
      );

      if (!action) {
        return;
      }

      if (action.label === 'Connect another board') {
        await vscode.commands.executeCommand('mekatrol.pydevice.connectboard', { forcePickPort: true });
        return;
      }

      const targetDeviceId = await pickConnectedDeviceId('Select a connected device to disconnect');
      if (!targetDeviceId) {
        return;
      }
      await closeConnectedPyDeviceByDeviceId(targetDeviceId, true);
      return;
    }

    await vscode.commands.executeCommand('mekatrol.pydevice.connectboard');
  });

  context.subscriptions.push(command);
};

export const initConnectionStateMonitor = (context: vscode.ExtensionContext): void => {
  const timer = setInterval(() => {
    void pruneStaleConnectedDevices();
  }, connectionStateMonitorIntervalMs);

  context.subscriptions.push({
    dispose: () => clearInterval(timer)
  });
};

export const tryReconnectBoardOnStartup = async (_context: vscode.ExtensionContext): Promise<void> => {
  const autoReconnectEnabled = getWorkspaceCacheValue<boolean>(autoReconnectDevicesCacheKey) ?? false;

  if (!autoReconnectEnabled || isBoardConnected()) {
    return;
  }

  const reconnectDevicePaths = reconnectStateStore.readReconnectDevicePaths();
  const baudRate = defaultBaudRate;

  if (reconnectDevicePaths.length === 0) {
    return;
  }

  for (const devicePath of reconnectDevicePaths) {
    if (getConnectedPyDeviceByPortPath(devicePath)) {
      continue;
    }

    try {
      await connectBoardForPath(devicePath, baudRate, false);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logChannelOutput(`Auto reconnect skipped for ${devicePath}: ${reason}`, false);
    }
  }
};

export const initSetAutoReconnectCommand = (context: vscode.ExtensionContext) => {
  const command = vscode.commands.registerCommand('mekatrol.pydevice.setautoreconnect', async () => {
    const currentValue = getWorkspaceCacheValue<boolean>(autoReconnectDevicesCacheKey) ?? false;

    const selected = await vscode.window.showQuickPick(
      [
        {
          label: 'Enable',
          description: 'Reconnect previously connected devices on startup when the last session had active connections',
          picked: currentValue
        },
        {
          label: 'Disable',
          description: 'Do not auto reconnect on startup',
          picked: !currentValue
        }
      ],
      {
        placeHolder: 'Set auto reconnect behavior'
      }
    );

    if (!selected) {
      return;
    }

    const enabled = selected.label === 'Enable';
    await setWorkspaceCacheValue(autoReconnectDevicesCacheKey, enabled);

    const msg = `Auto reconnect is now ${enabled ? 'enabled' : 'disabled'}.`;
    vscode.window.showInformationMessage(msg);
    logChannelOutput(msg, true);
  });

  context.subscriptions.push(command);
};

export const initSoftRebootBoardCommand = (context: vscode.ExtensionContext) => {
  const command = vscode.commands.registerCommand('mekatrol.pydevice.softreboot', async (arg?: unknown) => {
    const targetDeviceId = typeof arg === 'string'
      ? arg
      : typeof arg === 'object' && arg && 'deviceId' in arg && typeof (arg as { deviceId?: unknown }).deviceId === 'string'
        ? (arg as { deviceId: string }).deviceId
        : await pickConnectedDeviceId('Select a connected device to soft reboot');

    if (!targetDeviceId) {
      const msg = 'Connect to a board before soft rebooting.';
      vscode.window.showWarningMessage(msg);
      logChannelOutput(msg, true);
      return;
    }

    const state = boardRegistry.getByDeviceId(targetDeviceId);
    if (!state) {
      const msg = `Device ${targetDeviceId} is not connected.`;
      vscode.window.showWarningMessage(msg);
      logChannelOutput(msg, true);
      return;
    }

    if (state.executionCount > 0) {
      const msg = `Device ${targetDeviceId} is currently executing. Stop execution before soft rebooting.`;
      vscode.window.showWarningMessage(msg);
      logChannelOutput(msg, true);
      return;
    }

    const activeDebugSession = vscode.debug.activeDebugSession;
    if (activeDebugSession?.type === pydeviceDebugType) {
      await vscode.debug.stopDebugging(activeDebugSession);
      const msg = 'Stopped active debug session. Device will soft reboot on debug termination.';
      vscode.window.showInformationMessage(msg);
      logChannelOutput(msg, true);
      return;
    }

    try {
      await state.board.softReboot();
      const msg = `Device soft reboot complete for ${targetDeviceId}.`;
      vscode.window.showInformationMessage(msg);
      logChannelOutput(msg, true);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const msg = `Device soft reboot failed for ${targetDeviceId}. ${reason}`;
      vscode.window.showErrorMessage(msg);
      logChannelOutput(msg, true);
    }
  });

  context.subscriptions.push(command);
};
