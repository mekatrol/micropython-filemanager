/**
 * Module overview:
 * This file is part of the Pydevice extension runtime and contains
 * feature-specific logic isolated for maintainability and unit testing.
 */
import * as vscode from 'vscode';
import { logChannelOutput } from '../output-channel';
import { BoardRuntimeInfo, Pydevice } from '../utils/pydevice';
import { listSerialDevices } from '../utils/serial-port';
import { getWorkspaceCacheValue, setWorkspaceCacheValue } from '../utils/workspace-cache';
import { ConnectedBoardRegistry, ConnectedBoardState, ConnectedBoardSnapshot } from '../devices/connected-board-registry';
import { ReconnectStateStore } from '../devices/reconnect-state-store';
import { toDeviceId } from '../devices/device-id';

const reconnectLastSessionStateKey = 'reconnectLastSession';
const reconnectDevicePathsStateKey = 'reconnectDevicePaths';
const defaultBaudRate = 115200;
const runtimeInfoConnectRetryAttempts = 3;
const runtimeInfoConnectRetryDelayMs = 250;
const runtimeInfoBackgroundRetryAttempts = 5;
const runtimeInfoBackgroundRetryDelayMs = 1000;
const runtimeInfoRecoveryProbeAttempts = 5;
const runtimeInfoRecoveryProbeDelayMs = 300;
const runtimeInfoRecoveryRebootAttempts = 2;
const runtimeInfoRecoveryRebootDelayMs = 500;
const autoReconnectSettingKey = 'autoReconnectLastDevice';
const deviceDocumentScheme = 'pydevice-device';
const pydeviceDebugType = 'pydevice';

export type { ConnectedBoardSnapshot } from '../devices/connected-board-registry';

const boardRegistry = new ConnectedBoardRegistry();
const boardConnectionStateEmitter = new vscode.EventEmitter<boolean>();
const boardConnectionsChangedEmitter = new vscode.EventEmitter<ConnectedBoardSnapshot[]>();
const boardRuntimeInfoChangedEmitter = new vscode.EventEmitter<BoardRuntimeInfo | undefined>();
const boardExecutionStateChangedEmitter = new vscode.EventEmitter<ConnectedBoardSnapshot[]>();

export const onBoardConnectionStateChanged = boardConnectionStateEmitter.event;
export const onBoardConnectionsChanged = boardConnectionsChangedEmitter.event;
export const onConnectedBoardRuntimeInfoChanged = boardRuntimeInfoChangedEmitter.event;
export const onBoardExecutionStateChanged = boardExecutionStateChangedEmitter.event;

const reconnectStateStore = new ReconnectStateStore(
  <T>(key: string): T | undefined => getWorkspaceCacheValue<T>(key),
  async <T>(key: string, value: T): Promise<void> => setWorkspaceCacheValue(key, value),
  reconnectLastSessionStateKey,
  reconnectDevicePathsStateKey
);

const wait = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const getConnectedBoardStateByPortPath = (devicePath: string): ConnectedBoardState | undefined =>
  boardRegistry.getByPortPath(devicePath);

const readBoardRuntimeInfoWithRetries = async (
  board: Pydevice,
  devicePath: string,
  attempts: number,
  delayMs: number
): Promise<BoardRuntimeInfo | undefined> => {
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
  board: Pydevice,
  devicePath: string
): Promise<BoardRuntimeInfo | undefined> => {
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

const updateReconnectState = async (shouldReconnectOnStartup: boolean): Promise<void> => {
  await reconnectStateStore.writeShouldReconnect(shouldReconnectOnStartup);
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

const notifyStateChanged = (): void => {
  const snapshots = boardRegistry.getSnapshots();
  const connected = snapshots.length > 0;
  void vscode.commands.executeCommand('setContext', 'mekatrol.pydevice.boardConnected', connected);
  void vscode.commands.executeCommand('setContext', 'mekatrol.pydevice.connectedBoardCount', snapshots.length);
  boardConnectionStateEmitter.fire(connected);
  boardConnectionsChangedEmitter.fire(snapshots);
  boardRuntimeInfoChangedEmitter.fire(getConnectedBoardRuntimeInfo());
  boardExecutionStateChangedEmitter.fire(snapshots);
};

export const isBoardConnected = (): boolean => boardRegistry.isConnected();

export const getConnectedBoard = (deviceId?: string): Pydevice | undefined => {
  return boardRegistry.getByDeviceId(deviceId)?.board;
};

export const getConnectedBoardByPortPath = (devicePath: string): Pydevice | undefined => {
  return getConnectedBoardStateByPortPath(devicePath)?.board;
};

export const getConnectedBoardRuntimeInfo = (deviceId?: string): BoardRuntimeInfo | undefined => {
  return boardRegistry.getByDeviceId(deviceId)?.runtimeInfo;
};

export const getConnectedBoards = (): ConnectedBoardSnapshot[] => boardRegistry.getSnapshots();

export const getConnectedDeviceIds = (): string[] => boardRegistry.getConnectedDeviceIds();

export const getDeviceIdForPortPath = (devicePath: string): string | undefined => {
  return getConnectedBoardStateByPortPath(devicePath)?.deviceId;
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
): Promise<ConnectedBoardState | undefined> => {
  const existingForPath = getConnectedBoardStateByPortPath(devicePath);
  if (existingForPath) {
    if (showMessages) {
      const msg = `Device already connected: ${existingForPath.deviceId} on ${devicePath}.`;
      vscode.window.showInformationMessage(msg);
      logChannelOutput(msg, true);
    }
    return existingForPath;
  }

  const board = new Pydevice(devicePath, baudRate);
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

  const state: ConnectedBoardState = {
    deviceId,
    board,
    runtimeInfo,
    executionCount: 0
  };

  boardRegistry.add(state);
  await reconnectStateStore.addReconnectDevicePath(board.device);
  await updateReconnectState(true);
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

export const closeConnectedBoardByDeviceId = async (
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

    if (!preserveReconnectState && !boardRegistry.isConnected()) {
      await updateReconnectState(false);
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

export const closeConnectedBoard = async (
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

  return closeConnectedBoardByDeviceId(
    active.deviceId,
    showSuccessMessage,
    preserveReconnectState,
    promptToSaveDirtyDeviceFiles,
    closeDeviceTabsAfterDisconnect
  );
};

export const closeAllConnectedBoards = async (
  showSuccessMessage = false,
  preserveReconnectState = false,
  promptToSaveDirtyDeviceFiles = false,
  closeDeviceTabsAfterDisconnect = false
): Promise<boolean> => {
  const deviceIds = getConnectedDeviceIds();
  for (const deviceId of deviceIds) {
    const closed = await closeConnectedBoardByDeviceId(
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
    await updateReconnectState(false);
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

const pickSerialPortToConnect = async (onlyUnconnected: boolean = false): Promise<string | undefined> => {
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

  const items = candidatePorts.map((port) => {
    const details = [port.manufacturer, `VID:${port.vendorId}`, `PID:${port.productId}`].filter(Boolean).join(' | ');
    const alreadyConnected = connectedPaths.has(port.path);
    return {
      label: port.path,
      description: alreadyConnected ? `already connected${details ? ` | ${details}` : ''}` : details,
      picked: false
    };
  });

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select a serial port to connect',
    canPickMany: false,
    ignoreFocusOut: true
  });

  return selected?.label;
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
        devicePath = await pickSerialPortToConnect(forcePickPort);
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
      const workspaceWarning = 'No workspace folder is open. Device can connect, but it will not appear in Pydevice Explorer until you open a workspace folder.';
      vscode.window.showWarningMessage(workspaceWarning);
      logChannelOutput(workspaceWarning, true);
    }

    if (getConnectedBoardByPortPath(devicePath)) {
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

export const initEsp32RecoveryConnectCommand = (context: vscode.ExtensionContext) => {
  const command = vscode.commands.registerCommand('mekatrol.pydevice.connectboardesp32recovery', async (arg?: unknown) => {
    const devicePath = typeof arg === 'string'
      ? arg
      : typeof arg === 'object' && arg && 'devicePath' in arg && typeof (arg as { devicePath?: unknown }).devicePath === 'string'
        ? (arg as { devicePath: string }).devicePath
        : undefined;

    await vscode.commands.executeCommand('mekatrol.pydevice.connectboard', {
      forcePickPort: !devicePath,
      devicePath,
      recoveryMode: true
    });
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

    await closeConnectedBoardByDeviceId(targetDeviceId, true);
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
      await closeConnectedBoardByDeviceId(targetDeviceId, true);
      return;
    }

    await vscode.commands.executeCommand('mekatrol.pydevice.connectboard');
  });

  context.subscriptions.push(command);
};

export const tryReconnectBoardOnStartup = async (context: vscode.ExtensionContext): Promise<void> => {
  const autoReconnectEnabled = vscode.workspace
    .getConfiguration('mekatrol.pydevice')
    .get<boolean>('autoReconnectLastDevice', false);

  if (!autoReconnectEnabled || isBoardConnected()) {
    return;
  }

  const shouldReconnect = reconnectStateStore.readShouldReconnect();
  if (!shouldReconnect) {
    return;
  }

  const reconnectDevicePaths = reconnectStateStore.readReconnectDevicePaths();
  const baudRate = defaultBaudRate;

  if (reconnectDevicePaths.length === 0) {
    await vscode.commands.executeCommand('mekatrol.pydevice.connectboard');
    return;
  }

  for (const devicePath of reconnectDevicePaths) {
    if (getConnectedBoardByPortPath(devicePath)) {
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
    const configuration = vscode.workspace.getConfiguration('mekatrol.pydevice');
    const currentValue = configuration.get<boolean>(autoReconnectSettingKey, false);

    const selected = await vscode.window.showQuickPick(
      [
        {
          label: 'Enable',
          description: 'Reconnect to last selected device on startup when last session had an active connection',
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
    await configuration.update(autoReconnectSettingKey, enabled, vscode.ConfigurationTarget.Global);

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
