import * as vscode from 'vscode';
import { logChannelOutput } from '../output-channel';
import { BoardRuntimeInfo, Pyboard } from '../utils/pyboard';

const selectedSerialPortStateKey = 'selectedSerialPort';
const selectedBaudRateStateKey = 'selectedBaudRate';
const reconnectLastSessionStateKey = 'reconnectLastSession';
const defaultBaudRate = 115200;
const autoReconnectSettingKey = 'autoReconnectLastDevice';
const remoteDocumentScheme = 'pyboarddev-remote';
const pyboardDebugType = 'pyboarddev';

let connectedBoard: Pyboard | undefined;
let connectedBoardRuntimeInfo: BoardRuntimeInfo | undefined;
let extensionContext: vscode.ExtensionContext | undefined;
const boardConnectionStateEmitter = new vscode.EventEmitter<boolean>();
const boardRuntimeInfoChangedEmitter = new vscode.EventEmitter<BoardRuntimeInfo | undefined>();

export const onBoardConnectionStateChanged = boardConnectionStateEmitter.event;
export const onConnectedBoardRuntimeInfoChanged = boardRuntimeInfoChangedEmitter.event;
export const isBoardConnected = (): boolean => connectedBoard !== undefined;
export const getConnectedBoard = (): Pyboard | undefined => connectedBoard;
export const getConnectedBoardRuntimeInfo = (): BoardRuntimeInfo | undefined => connectedBoardRuntimeInfo;

const notifyBoardConnectionStateChanged = (): void => {
  void vscode.commands.executeCommand('setContext', 'mekatrol.pyboarddev.boardConnected', isBoardConnected());
  boardConnectionStateEmitter.fire(isBoardConnected());
};

const notifyBoardRuntimeInfoChanged = (): void => {
  boardRuntimeInfoChangedEmitter.fire(connectedBoardRuntimeInfo);
};

const readPersistentState = <T>(context: vscode.ExtensionContext, key: string): T | undefined => {
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

const updateReconnectState = async (shouldReconnectOnStartup: boolean): Promise<void> => {
  if (!extensionContext) {
    return;
  }

  await writePersistentState(extensionContext, reconnectLastSessionStateKey, shouldReconnectOnStartup);
};

const getDirtyRemoteDocuments = (): vscode.TextDocument[] =>
  vscode.workspace.textDocuments.filter((document) => document.uri.scheme === remoteDocumentScheme && document.isDirty);

const saveDirtyRemoteDocumentsBeforeDisconnect = async (): Promise<boolean> => {
  const dirtyDocuments = getDirtyRemoteDocuments();
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

const getOpenRemoteTabs = (): vscode.Tab[] => {
  const tabs: vscode.Tab[] = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (!(tab.input instanceof vscode.TabInputText)) {
        continue;
      }

      if (tab.input.uri.scheme !== remoteDocumentScheme) {
        continue;
      }

      tabs.push(tab);
    }
  }

  return tabs;
};

const closeOpenRemoteTabsAfterDisconnect = async (): Promise<void> => {
  const remoteTabs = getOpenRemoteTabs();
  if (remoteTabs.length === 0) {
    return;
  }

  const closed = await vscode.window.tabGroups.close(remoteTabs, true);
  if (!closed) {
    logChannelOutput('Disconnected, but some remote device tabs could not be closed.', true);
  }
};

export const closeConnectedBoard = async (
  showSuccessMessage = true,
  preserveReconnectState = false,
  promptToSaveDirtyDeviceFiles = true,
  closeRemoteTabsAfterDisconnect = true
): Promise<boolean> => {
  if (!connectedBoard) {
    if (showSuccessMessage) {
      const msg = 'No active board connection to close.';
      vscode.window.showInformationMessage(msg);
      logChannelOutput(msg, true);
    }
    return true;
  }

  if (promptToSaveDirtyDeviceFiles) {
    const canClose = await saveDirtyRemoteDocumentsBeforeDisconnect();
    if (!canClose) {
      return false;
    }
  }

  try {
    await connectedBoard.close();
    connectedBoard = undefined;
    connectedBoardRuntimeInfo = undefined;
    if (!preserveReconnectState) {
      await updateReconnectState(false);
    }
    notifyBoardConnectionStateChanged();
    notifyBoardRuntimeInfoChanged();
    if (closeRemoteTabsAfterDisconnect) {
      await closeOpenRemoteTabsAfterDisconnect();
    }

    if (showSuccessMessage) {
      const msg = 'Board connection closed.';
      vscode.window.showInformationMessage(msg);
      logChannelOutput(msg, true);
    } else {
      logChannelOutput('Board connection closed during extension shutdown.', false);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const msg = `Failed to close board connection. ${reason}`;
    logChannelOutput(msg, true);
    return false;
  }

  return true;
};

export const initConnectBoardCommand = (context: vscode.ExtensionContext) => {
  extensionContext = context;

  const command = vscode.commands.registerCommand('mekatrol.pyboarddev.connectboard', async () => {
    const device = readPersistentState<string>(context, selectedSerialPortStateKey);
    const baudRate = readPersistentState<number>(context, selectedBaudRateStateKey) ?? defaultBaudRate;

    if (!device) {
      const msg = 'No serial device selected. Select a serial port first.';
      vscode.window.showWarningMessage(msg);
      logChannelOutput(msg, true);
      return;
    }

    try {
      if (connectedBoard) {
        const closed = await closeConnectedBoard(false);
        if (!closed) {
          return;
        }
      }

      const board = new Pyboard(device, baudRate);
      await board.open();
      connectedBoard = board;
      await updateReconnectState(true);
      notifyBoardConnectionStateChanged();
      connectedBoardRuntimeInfo = undefined;
      notifyBoardRuntimeInfoChanged();

      try {
        connectedBoardRuntimeInfo = await board.getBoardRuntimeInfo();
        notifyBoardRuntimeInfoChanged();
      } catch (infoError) {
        const reason = infoError instanceof Error ? infoError.message : String(infoError);
        logChannelOutput(`Connected, but failed to read board runtime info: ${reason}`, false);
      }

      const msg = `Connected to board on ${device} @ ${baudRate}.`;
      vscode.window.showInformationMessage(msg);
      logChannelOutput(msg, true);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const msg = `Failed to connect to board on ${device} @ ${baudRate}. ${reason}`;
      vscode.window.showErrorMessage(msg);
      logChannelOutput(msg, true);
    }
  });

  context.subscriptions.push(command);
  notifyBoardConnectionStateChanged();
};

export const initDisconnectBoardCommand = (context: vscode.ExtensionContext) => {
  extensionContext = context;

  const command = vscode.commands.registerCommand('mekatrol.pyboarddev.disconnectboard', async () => {
    await closeConnectedBoard(true);
  });

  context.subscriptions.push(command);
};

export const initToggleBoardConnectionCommand = (context: vscode.ExtensionContext) => {
  extensionContext = context;

  const command = vscode.commands.registerCommand('mekatrol.pyboarddev.toggleboardconnection', async () => {
    if (isBoardConnected()) {
      await closeConnectedBoard(true);
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

  await vscode.commands.executeCommand('mekatrol.pyboarddev.connectboard');
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
          description: 'Reconnect to last device on startup when last session was connected',
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

  const command = vscode.commands.registerCommand('mekatrol.pyboarddev.softreboot', async () => {
    if (!connectedBoard) {
      const msg = 'Connect to a board before soft rebooting.';
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
      await connectedBoard.softReboot();
      const msg = 'Device soft reboot complete.';
      vscode.window.showInformationMessage(msg);
      logChannelOutput(msg, true);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const msg = `Device soft reboot failed. ${reason}`;
      vscode.window.showErrorMessage(msg);
      logChannelOutput(msg, true);
    }
  });

  context.subscriptions.push(command);
};
