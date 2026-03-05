import * as vscode from 'vscode';
import { logChannelOutput } from '../output-channel';
import { BoardRuntimeInfo, Pyboard } from '../utils/pyboard';
import { listSerialDevices } from '../utils/serial-port';

const selectedSerialPortStateKey = 'selectedSerialPort';
const selectedBaudRateStateKey = 'selectedBaudRate';
const reconnectLastSessionStateKey = 'reconnectLastSession';
const reconnectDevicePathsStateKey = 'reconnectDevicePaths';
const defaultBaudRate = 115200;
const autoReconnectSettingKey = 'autoReconnectLastDevice';
const remoteDocumentScheme = 'pyboarddev-remote';
const pyboardDebugType = 'pyboarddev';

interface ConnectedBoardState {
  deviceId: string;
  board: Pyboard;
  runtimeInfo: BoardRuntimeInfo | undefined;
  executionCount: number;
}

export interface ConnectedBoardSnapshot {
  deviceId: string;
  devicePath: string;
  baudRate: number;
  runtimeInfo: BoardRuntimeInfo | undefined;
  executionCount: number;
}

let extensionContext: vscode.ExtensionContext | undefined;
const connectedBoards = new Map<string, ConnectedBoardState>();
const deviceIdByPortPath = new Map<string, string>();
const boardConnectionStateEmitter = new vscode.EventEmitter<boolean>();
const boardConnectionsChangedEmitter = new vscode.EventEmitter<ConnectedBoardSnapshot[]>();
const boardRuntimeInfoChangedEmitter = new vscode.EventEmitter<BoardRuntimeInfo | undefined>();
const boardExecutionStateChangedEmitter = new vscode.EventEmitter<ConnectedBoardSnapshot[]>();

export const onBoardConnectionStateChanged = boardConnectionStateEmitter.event;
export const onBoardConnectionsChanged = boardConnectionsChangedEmitter.event;
export const onConnectedBoardRuntimeInfoChanged = boardRuntimeInfoChangedEmitter.event;
export const onBoardExecutionStateChanged = boardExecutionStateChangedEmitter.event;

const readPersistentState = <T>(context: vscode.ExtensionContext | undefined, key: string): T | undefined => {
  if (!context) {
    return undefined;
  }

  const fromGlobal = context.globalState.get<T>(key);
  if (fromGlobal !== undefined) {
    return fromGlobal;
  }

  return context.workspaceState.get<T>(key);
};

const writePersistentState = async <T>(context: vscode.ExtensionContext, key: string, value: T): Promise<void> => {
  await context.globalState.update(key, value);
  await context.workspaceState.update(key, value);
};

const readReconnectDevicePaths = (context: vscode.ExtensionContext | undefined): string[] => {
  const stored = readPersistentState<unknown>(context, reconnectDevicePathsStateKey);
  if (!Array.isArray(stored)) {
    return [];
  }

  const normalised = stored
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return [...new Set(normalised)];
};

const writeReconnectDevicePaths = async (context: vscode.ExtensionContext, devicePaths: string[]): Promise<void> => {
  const next = [...new Set(devicePaths.map((item) => item.trim()).filter((item) => item.length > 0))];
  await writePersistentState(context, reconnectDevicePathsStateKey, next);
};

const addReconnectDevicePath = async (context: vscode.ExtensionContext | undefined, devicePath: string): Promise<void> => {
  if (!context) {
    return;
  }

  const current = readReconnectDevicePaths(context);
  if (current.includes(devicePath)) {
    return;
  }

  await writeReconnectDevicePaths(context, [...current, devicePath]);
};

const removeReconnectDevicePath = async (context: vscode.ExtensionContext | undefined, devicePath: string): Promise<void> => {
  if (!context) {
    return;
  }

  const current = readReconnectDevicePaths(context);
  if (!current.includes(devicePath)) {
    return;
  }

  await writeReconnectDevicePaths(context, current.filter((item) => item !== devicePath));
};

const normaliseDeviceId = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    return 'unknown-device';
  }

  return trimmed.replace(/\s+/g, '-').replace(/[^\w.-]/g, '_');
};

const toDeviceId = (devicePath: string, runtimeInfo?: BoardRuntimeInfo): string => {
  if (runtimeInfo?.uniqueId && runtimeInfo.uniqueId.trim().length > 0) {
    return normaliseDeviceId(runtimeInfo.uniqueId);
  }

  return `port_${normaliseDeviceId(devicePath)}`;
};

const getConnectedBoardStateByPortPath = (devicePath: string): ConnectedBoardState | undefined => {
  const existingDeviceId = deviceIdByPortPath.get(devicePath);
  if (!existingDeviceId) {
    return undefined;
  }

  return connectedBoards.get(existingDeviceId);
};

const toSnapshot = (state: ConnectedBoardState): ConnectedBoardSnapshot => ({
  deviceId: state.deviceId,
  devicePath: state.board.device,
  baudRate: state.board.baudrate,
  runtimeInfo: state.runtimeInfo,
  executionCount: state.executionCount
});

const getSnapshots = (): ConnectedBoardSnapshot[] => {
  return [...connectedBoards.values()].map(toSnapshot).sort((a, b) => a.deviceId.localeCompare(b.deviceId));
};

const getPreferredDevicePath = (): string | undefined => {
  return readPersistentState<string>(extensionContext, selectedSerialPortStateKey);
};

const getActiveBoardState = (): ConnectedBoardState | undefined => {
  const preferredPath = getPreferredDevicePath();
  if (preferredPath) {
    const byPreferredPath = getConnectedBoardStateByPortPath(preferredPath);
    if (byPreferredPath) {
      return byPreferredPath;
    }
  }

  return connectedBoards.values().next().value as ConnectedBoardState | undefined;
};

const updateReconnectState = async (shouldReconnectOnStartup: boolean): Promise<void> => {
  if (!extensionContext) {
    return;
  }

  await writePersistentState(extensionContext, reconnectLastSessionStateKey, shouldReconnectOnStartup);
};

const parseDeviceIdFromRemoteUri = (uri: vscode.Uri): string | undefined => {
  if (uri.scheme !== remoteDocumentScheme) {
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

const getDirtyRemoteDocuments = (deviceId?: string): vscode.TextDocument[] => {
  return vscode.workspace.textDocuments.filter((document) => {
    if (document.uri.scheme !== remoteDocumentScheme || !document.isDirty) {
      return false;
    }

    if (!deviceId) {
      return true;
    }

    return parseDeviceIdFromRemoteUri(document.uri) === deviceId;
  });
};

const saveDirtyRemoteDocumentsBeforeDisconnect = async (deviceId?: string): Promise<boolean> => {
  const dirtyDocuments = getDirtyRemoteDocuments(deviceId);
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

const getOpenRemoteTabs = (deviceId?: string): vscode.Tab[] => {
  const tabs: vscode.Tab[] = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (!(tab.input instanceof vscode.TabInputText)) {
        continue;
      }

      if (tab.input.uri.scheme !== remoteDocumentScheme) {
        continue;
      }

      if (deviceId) {
        const tabDeviceId = parseDeviceIdFromRemoteUri(tab.input.uri);
        if (tabDeviceId !== deviceId) {
          continue;
        }
      }

      tabs.push(tab);
    }
  }

  return tabs;
};

const closeOpenRemoteTabsAfterDisconnect = async (deviceId?: string): Promise<void> => {
  const remoteTabs = getOpenRemoteTabs(deviceId);
  if (remoteTabs.length === 0) {
    return;
  }

  const closed = await vscode.window.tabGroups.close(remoteTabs, true);
  if (!closed) {
    logChannelOutput('Disconnected, but some remote device tabs could not be closed.', true);
  }
};

const notifyStateChanged = (): void => {
  const snapshots = getSnapshots();
  const connected = snapshots.length > 0;
  void vscode.commands.executeCommand('setContext', 'mekatrol.pyboarddev.boardConnected', connected);
  void vscode.commands.executeCommand('setContext', 'mekatrol.pyboarddev.connectedBoardCount', snapshots.length);
  boardConnectionStateEmitter.fire(connected);
  boardConnectionsChangedEmitter.fire(snapshots);
  boardRuntimeInfoChangedEmitter.fire(getConnectedBoardRuntimeInfo());
  boardExecutionStateChangedEmitter.fire(snapshots);
};

export const isBoardConnected = (): boolean => connectedBoards.size > 0;

export const getConnectedBoard = (deviceId?: string): Pyboard | undefined => {
  if (deviceId) {
    return connectedBoards.get(deviceId)?.board;
  }

  return getActiveBoardState()?.board;
};

export const getConnectedBoardByPortPath = (devicePath: string): Pyboard | undefined => {
  return getConnectedBoardStateByPortPath(devicePath)?.board;
};

export const getConnectedBoardRuntimeInfo = (deviceId?: string): BoardRuntimeInfo | undefined => {
  if (deviceId) {
    return connectedBoards.get(deviceId)?.runtimeInfo;
  }

  return getActiveBoardState()?.runtimeInfo;
};

export const getConnectedBoards = (): ConnectedBoardSnapshot[] => getSnapshots();

export const getConnectedDeviceIds = (): string[] => getSnapshots().map((item) => item.deviceId);

export const getDeviceIdForPortPath = (devicePath: string): string | undefined => {
  return getConnectedBoardStateByPortPath(devicePath)?.deviceId;
};

export const beginBoardExecution = (deviceId: string): void => {
  const state = connectedBoards.get(deviceId);
  if (!state) {
    return;
  }

  state.executionCount += 1;
  notifyStateChanged();
};

export const endBoardExecution = (deviceId: string): void => {
  const state = connectedBoards.get(deviceId);
  if (!state) {
    return;
  }

  state.executionCount = Math.max(0, state.executionCount - 1);
  notifyStateChanged();
};

export const isBoardExecuting = (deviceId: string): boolean => {
  return (connectedBoards.get(deviceId)?.executionCount ?? 0) > 0;
};

const connectBoardForPath = async (
  devicePath: string,
  baudRate: number,
  showMessages: boolean
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

  const board = new Pyboard(devicePath, baudRate);
  await board.open();

  let runtimeInfo: BoardRuntimeInfo | undefined;
  try {
    runtimeInfo = await board.getBoardRuntimeInfo();
  } catch (infoError) {
    const reason = infoError instanceof Error ? infoError.message : String(infoError);
    logChannelOutput(`Connected, but failed to read board runtime info: ${reason}`, false);
  }

  const deviceId = toDeviceId(devicePath, runtimeInfo);
  if (connectedBoards.has(deviceId)) {
    await board.close();
    throw new Error(`A board with device ID ${deviceId} is already connected.`);
  }

  const state: ConnectedBoardState = {
    deviceId,
    board,
    runtimeInfo,
    executionCount: 0
  };

  connectedBoards.set(deviceId, state);
  deviceIdByPortPath.set(board.device, deviceId);
  await addReconnectDevicePath(extensionContext, board.device);
  await updateReconnectState(true);
  notifyStateChanged();

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
  closeRemoteTabsAfterDisconnect = true
): Promise<boolean> => {
  const state = connectedBoards.get(deviceId);
  if (!state) {
    if (showSuccessMessage) {
      const msg = `No active board connection found for ${deviceId}.`;
      vscode.window.showInformationMessage(msg);
      logChannelOutput(msg, true);
    }
    return true;
  }

  if (promptToSaveDirtyDeviceFiles) {
    const canClose = await saveDirtyRemoteDocumentsBeforeDisconnect(deviceId);
    if (!canClose) {
      return false;
    }
  }

  try {
    await state.board.close();
    connectedBoards.delete(deviceId);
    deviceIdByPortPath.delete(state.board.device);
    if (!preserveReconnectState) {
      await removeReconnectDevicePath(extensionContext, state.board.device);
    }

    if (!preserveReconnectState && connectedBoards.size === 0) {
      await updateReconnectState(false);
    }

    notifyStateChanged();

    if (closeRemoteTabsAfterDisconnect) {
      await closeOpenRemoteTabsAfterDisconnect(deviceId);
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
  closeRemoteTabsAfterDisconnect = true
): Promise<boolean> => {
  const active = getActiveBoardState();
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
    closeRemoteTabsAfterDisconnect
  );
};

export const closeAllConnectedBoards = async (
  showSuccessMessage = false,
  preserveReconnectState = false,
  promptToSaveDirtyDeviceFiles = false,
  closeRemoteTabsAfterDisconnect = false
): Promise<boolean> => {
  const deviceIds = getConnectedDeviceIds();
  for (const deviceId of deviceIds) {
    const closed = await closeConnectedBoardByDeviceId(
      deviceId,
      showSuccessMessage,
      preserveReconnectState,
      promptToSaveDirtyDeviceFiles,
      closeRemoteTabsAfterDisconnect
    );
    if (!closed) {
      return false;
    }
  }

  if (!preserveReconnectState) {
    await updateReconnectState(false);
    if (extensionContext) {
      await writeReconnectDevicePaths(extensionContext, []);
    }
  }

  return true;
};

const pickConnectedDeviceId = async (placeHolder: string): Promise<string | undefined> => {
  const snapshots = getSnapshots();
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

const pickSerialPortToConnect = async (
  context: vscode.ExtensionContext,
  onlyUnconnected: boolean = false
): Promise<string | undefined> => {
  const ports = await listSerialDevices();
  if (ports.length === 0) {
    const msg = 'No serial devices found.';
    vscode.window.showWarningMessage(msg);
    logChannelOutput(msg, true);
    return undefined;
  }

  const connectedPaths = new Set(getSnapshots().map((item) => item.devicePath));
  const activePath = readPersistentState<string>(context, selectedSerialPortStateKey);
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
      picked: port.path === activePath
    };
  });

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select a serial port to connect',
    canPickMany: false,
    ignoreFocusOut: true
  });

  if (!selected) {
    return undefined;
  }

  await writePersistentState(context, selectedSerialPortStateKey, selected.label);
  return selected.label;
};

export const initConnectBoardCommand = (context: vscode.ExtensionContext) => {
  extensionContext = context;

  const command = vscode.commands.registerCommand('mekatrol.pyboarddev.connectboard', async (arg?: unknown) => {
    const forcePickPort = Boolean(
      arg === true
      || (typeof arg === 'object' && arg && 'forcePickPort' in arg && (arg as { forcePickPort?: unknown }).forcePickPort === true)
    );
    let devicePath = readPersistentState<string>(context, selectedSerialPortStateKey);
    const baudRate = readPersistentState<number>(context, selectedBaudRateStateKey) ?? defaultBaudRate;
    const selectedIsAlreadyConnected = Boolean(devicePath && getConnectedBoardByPortPath(devicePath));

    if (forcePickPort || !devicePath || selectedIsAlreadyConnected) {
      try {
        devicePath = await pickSerialPortToConnect(context, forcePickPort || selectedIsAlreadyConnected);
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

    if (getConnectedBoardByPortPath(devicePath)) {
      const msg = `Device on ${devicePath} is already connected. Choose another serial port.`;
      vscode.window.showWarningMessage(msg);
      logChannelOutput(msg, true);
      return;
    }

    try {
      await connectBoardForPath(devicePath, baudRate, true);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const msg = `Failed to connect to board on ${devicePath} @ ${baudRate}. ${reason}`;
      vscode.window.showErrorMessage(msg);
      logChannelOutput(msg, true);
    }
  });

  context.subscriptions.push(command);
  notifyStateChanged();
};

export const initDisconnectBoardCommand = (context: vscode.ExtensionContext) => {
  extensionContext = context;

  const command = vscode.commands.registerCommand('mekatrol.pyboarddev.disconnectboard', async (arg?: unknown) => {
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
  extensionContext = context;

  const command = vscode.commands.registerCommand('mekatrol.pyboarddev.toggleboardconnection', async () => {
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
        await vscode.commands.executeCommand('mekatrol.pyboarddev.connectboard', { forcePickPort: true });
        return;
      }

      const targetDeviceId = await pickConnectedDeviceId('Select a connected device to disconnect');
      if (!targetDeviceId) {
        return;
      }
      await closeConnectedBoardByDeviceId(targetDeviceId, true);
      return;
    }

    await vscode.commands.executeCommand('mekatrol.pyboarddev.connectboard');
  });

  context.subscriptions.push(command);
};

export const tryReconnectBoardOnStartup = async (context: vscode.ExtensionContext): Promise<void> => {
  extensionContext = context;

  const autoReconnectEnabled = vscode.workspace
    .getConfiguration('mekatrol.pyboarddev')
    .get<boolean>('autoReconnectLastDevice', false);

  if (!autoReconnectEnabled || isBoardConnected()) {
    return;
  }

  const shouldReconnect = readPersistentState<boolean>(context, reconnectLastSessionStateKey) ?? false;
  if (!shouldReconnect) {
    return;
  }

  const reconnectDevicePaths = readReconnectDevicePaths(context);
  const baudRate = readPersistentState<number>(context, selectedBaudRateStateKey) ?? defaultBaudRate;

  if (reconnectDevicePaths.length === 0) {
    await vscode.commands.executeCommand('mekatrol.pyboarddev.connectboard');
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
  extensionContext = context;

  const command = vscode.commands.registerCommand('mekatrol.pyboarddev.setautoreconnect', async () => {
    const configuration = vscode.workspace.getConfiguration('mekatrol.pyboarddev');
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
  extensionContext = context;

  const command = vscode.commands.registerCommand('mekatrol.pyboarddev.softreboot', async (arg?: unknown) => {
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

    const state = connectedBoards.get(targetDeviceId);
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
    if (activeDebugSession?.type === pyboardDebugType) {
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
