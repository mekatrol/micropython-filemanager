/**
 * Module overview:
 * This file is part of the PyDevice extension runtime and contains
 * feature-specific logic isolated for maintainability and unit testing.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { logChannelOutput } from '../output-channel';
import { PyDeviceConnection, PyDeviceRuntimeInfo } from '../devices/py-device';
import { listSerialDevices } from '../utils/serial-port';
import { getWorkspaceCacheValue, setWorkspaceCacheValue } from '../utils/workspace-cache';
import { ConnectedPyDeviceRegistry, ConnectedPyDeviceState, ConnectedPyDeviceSnapshot } from '../devices/connected-py-device-registry';
import { ReconnectStateStore } from '../devices/reconnect-state-store';
import { toDeviceId } from '../devices/device-id';
import { getDeviceNames, loadConfiguration, updateDeviceName } from '../utils/configuration';

const reconnectLastSessionStateKey = 'reconnectLastSession';
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
const autoReconnectSettingKey = 'autoReconnectLastDevice';
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
  reconnectLastSessionStateKey,
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
    const message = `Duplicate device names detected in .pydevice-config. ${summary}`;
    logChannelOutput(message, true);
    void vscode.window.showWarningMessage(message);
  }

  return distinct;
};

const wait = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
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

type RecoveryReconnectStatus = 'resolving' | 'ready' | 'connecting' | 'connected' | 'not_connected' | 'error';

interface RecoveryReconnectRow {
  id: string;
  devicePath: string;
  serialPortName: string;
  deviceId: string;
  deviceName: string;
  status: RecoveryReconnectStatus;
  errorText?: string;
  details?: string;
}

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

const renderRecoveryReconnectHtml = (rows: RecoveryReconnectRow[]): string => {
  const rowsJson = JSON.stringify(rows);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Recovery Reconnect</title>
  <style>
    :root { color-scheme: light dark; }
    body { margin: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); }
    .wrap { max-width: 1100px; margin: 28px auto; padding: 0 20px 20px; }
    h2 { margin: 0 0 10px; font-size: 16px; }
    .hint { margin: 0 0 12px; opacity: 0.9; }
    table { width: 100%; border-collapse: collapse; border: 1px solid var(--vscode-editorWidget-border); table-layout: fixed; }
    th, td { padding: 8px 10px; border-bottom: 1px solid var(--vscode-editorWidget-border); vertical-align: middle; }
    th { text-align: left; font-weight: 600; }
    th.name, td.name { width: 200px; }
    th.id, td.id { width: 320px; }
    th.port, td.port { width: 200px; }
    th.status, td.status { width: 220px; }
    td.id, td.port { font-family: var(--vscode-editor-font-family); font-size: 12px; }
    .status-wrap { display: inline-flex; align-items: center; gap: 8px; }
    .icon { width: 14px; height: 14px; display: inline-flex; align-items: center; justify-content: center; }
    .icon svg { width: 14px; height: 14px; fill: currentColor; }
    .spinner {
      width: 12px;
      height: 12px;
      border: 2px solid var(--vscode-descriptionForeground);
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .ok { color: var(--vscode-charts-green); font-weight: 600; }
    .err { color: var(--vscode-errorForeground); }
    .secondary-text { color: var(--vscode-descriptionForeground); }
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
    <h2>Recovery Reconnect</h2>
    <p class="hint">Device IDs are probed in the background. Reconnect individual rows or use Connect all.</p>
    <table>
      <thead>
        <tr>
          <th class="name">Device Name</th>
          <th class="id">Device ID</th>
          <th class="port">Serial Port</th>
          <th class="status">Status</th>
        </tr>
      </thead>
      <tbody id="rows"></tbody>
    </table>
    <div class="buttons">
      <button id="connectAll">Connect all</button>
      <button id="close" class="secondary">Close</button>
    </div>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const rows = ${rowsJson};
    const tbody = document.getElementById('rows');
    const passIconSvg = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.6484 5.64648C10.8434 5.45148 11.1605 5.45148 11.3555 5.64648C11.5498 5.84137 11.5499 6.15766 11.3555 6.35254L7.35547 10.3525C7.25747 10.4495 7.12898 10.499 7.00098 10.499C6.87299 10.499 6.74545 10.4505 6.64746 10.3525L4.64746 8.35254C4.45247 8.15754 4.45248 7.84148 4.64746 7.64648C4.84246 7.45148 5.15949 7.45148 5.35449 7.64648L7 9.29199L10.6465 5.64648H10.6484Z"></path><path fill-rule="evenodd" clip-rule="evenodd" d="M8 1C11.86 1 15 4.14 15 8C15 11.86 11.86 15 8 15C4.14 15 1 11.86 1 8C1 4.14 4.14 1 8 1ZM8 2C4.691 2 2 4.691 2 8C2 11.309 4.691 14 8 14C11.309 14 14 11.309 14 8C14 4.691 11.309 2 8 2Z"></path></svg>';
    const warningIconSvg = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M14.831 11.965L9.206 1.714C8.965 1.274 8.503 1 8 1C7.497 1 7.035 1.274 6.794 1.714L1.169 11.965C1.059 12.167 1 12.395 1 12.625C1 13.383 1.617 14 2.375 14H13.625C14.383 14 15 13.383 15 12.625C15 12.395 14.941 12.167 14.831 11.965ZM13.625 13H2.375C2.168 13 2 12.832 2 12.625C2 12.561 2.016 12.5 2.046 12.445L7.671 2.195C7.736 2.075 7.863 2 8 2C8.137 2 8.264 2.075 8.329 2.195L13.954 12.445C13.984 12.501 14 12.561 14 12.625C14 12.832 13.832 13 13.625 13ZM8.75 11.25C8.75 11.664 8.414 12 8 12C7.586 12 7.25 11.664 7.25 11.25C7.25 10.836 7.586 10.5 8 10.5C8.414 10.5 8.75 10.836 8.75 11.25ZM7.5 9V5.5C7.5 5.224 7.724 5 8 5C8.276 5 8.5 5.224 8.5 5.5V9C8.5 9.276 8.276 9.5 8 9.5C7.724 9.5 7.5 9.276 7.5 9Z"></path></svg>';
    const disconnectedIconSvg = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M7 2.5C7 2.224 7.224 2 7.5 2C7.776 2 8 2.224 8 2.5V7.5C8 7.776 7.776 8 7.5 8C7.224 8 7 7.776 7 7.5V2.5ZM7.5 11.5C7.086 11.5 6.75 11.164 6.75 10.75C6.75 10.336 7.086 10 7.5 10C7.914 10 8.25 10.336 8.25 10.75C8.25 11.164 7.914 11.5 7.5 11.5ZM12.884 13.591L11.586 12.293C10.506 13.345 9.03 14 7.4 14C4.093 14 1.4 11.309 1.4 8C1.4 5.316 3.172 3.041 5.607 2.284C5.871 2.202 6.149 2.35 6.231 2.613C6.313 2.877 6.165 3.155 5.902 3.237C3.874 3.867 2.4 5.762 2.4 8C2.4 10.758 4.643 13 7.4 13C8.753 13 9.979 12.46 10.88 11.586L9.62 10.326C9.425 10.131 9.425 9.815 9.62 9.62C9.815 9.425 10.131 9.425 10.326 9.62L13.591 12.884C13.786 13.079 13.786 13.395 13.591 13.59C13.396 13.786 13.079 13.786 12.884 13.591Z"></path></svg>';

    const statusHtml = (row) => {
      if (row.status === 'resolving') {
        return '<span class="status-wrap"><span class="spinner"></span><span class="secondary-text">Fetching ID...</span></span>';
      }
      if (row.status === 'connecting') {
        return '<span class="status-wrap"><span class="spinner"></span><span>Connecting...</span></span>';
      }
      if (row.status === 'connected') {
        return '<span class="status-wrap ok"><span class="icon">' + passIconSvg + '</span><span>Connected</span></span>';
      }
      if (row.status === 'error') {
        const errText = row.errorText ? ' - ' + row.errorText : '';
        return '<span class="status-wrap err"><span class="icon">' + warningIconSvg + '</span><span>Error' + errText + '</span></span>';
      }
      if (row.status === 'not_connected') {
        return '<span class="status-wrap secondary-text"><span class="icon">' + disconnectedIconSvg + '</span><span>Not connected</span></span>';
      }
      return '<button type="button" class="link" data-action="reconnect" data-id="' + row.id + '">Reconnect</button>';
    };

    const render = () => {
      tbody.innerHTML = '';
      for (const row of rows) {
        const nameHtml = row.deviceName
          ? row.deviceName
          : ('<button type="button" class="link" data-action="set-name" data-id="' + row.id + '">Set device name</button>');
        const tr = document.createElement('tr');
        tr.innerHTML =
          '<td class="name">' + nameHtml + '</td>' +
          '<td class="id">' + (row.deviceId || '') + '</td>' +
          '<td class="port">' + (row.serialPortName || '') + '</td>' +
          '<td class="status">' + statusHtml(row) + '</td>';
        tbody.appendChild(tr);
      }
      for (const button of document.querySelectorAll('button[data-action="reconnect"]')) {
        button.addEventListener('click', () => {
          vscode.postMessage({ type: 'reconnect', rowId: button.dataset.id });
        });
      }
      for (const button of document.querySelectorAll('button[data-action="set-name"]')) {
        button.addEventListener('click', () => {
          vscode.postMessage({ type: 'setName', rowId: button.dataset.id });
        });
      }
    };

    render();

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (!message || typeof message !== 'object') {
        return;
      }
      if (message.type === 'updateRow' && message.row && typeof message.row.id === 'string') {
        const index = rows.findIndex((item) => item.id === message.row.id);
        if (index >= 0) {
          rows[index] = message.row;
        } else {
          rows.push(message.row);
        }
        render();
        return;
      }
      if (message.type === 'replaceRows' && Array.isArray(message.rows)) {
        rows.splice(0, rows.length, ...message.rows);
        render();
      }
    });

    document.getElementById('connectAll').addEventListener('click', () => {
      vscode.postMessage({ type: 'connectAll' });
    });
    document.getElementById('close').addEventListener('click', () => {
      vscode.postMessage({ type: 'close' });
    });
  </script>
</body>
</html>`;
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

export const initEsp32RecoveryConnectCommand = (context: vscode.ExtensionContext) => {
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
      'pydevice.recoveryReconnect',
      'Recovery Reconnect',
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true }
    );
    panel.webview.html = renderRecoveryReconnectHtml([]);

    let rowsById = new Map<string, RecoveryReconnectRow>();
    const resolvedDeviceIdByPath = new Map<string, string>();
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

    const updateRow = (row: RecoveryReconnectRow): void => {
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
        for (const devicePath of [...resolvedDeviceIdByPath.keys()]) {
          if (!currentPortPaths.has(devicePath)) {
            resolvedDeviceIdByPath.delete(devicePath);
            wasConnectedByPath.delete(devicePath);
            wasPresentByPath.delete(devicePath);
          }
        }

        const nextRows = new Map<string, RecoveryReconnectRow>();
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
            !seenConfiguredDeviceIds.has(deviceId) && lastKnownDevicePortById[deviceId] === port.path
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
            // Port appeared where a configured device was last seen, but probed ID does not match.
            // Keep the configured row as not connected and create a distinct port row.
            rowId = `port:${port.path}`;
            existing = rowsById.get(rowId);
            deviceId = resolvedDeviceId;
            seenConfiguredDeviceIds.delete(claimedConfiguredId);
          }

          if (configuredDeviceIdSet.has(deviceId)) {
            seenConfiguredDeviceIds.add(deviceId);
          }

          let status: RecoveryReconnectStatus;
          if (connectedState) {
            status = 'connected';
          } else if (existing?.status === 'connecting') {
            status = 'connecting';
          } else if (existing?.status === 'error') {
            status = 'error';
          } else if (resolvedDeviceId) {
            status = 'ready';
          } else {
            status = 'resolving';
          }

          const row: RecoveryReconnectRow = {
            id: rowId,
            devicePath: port.path,
            serialPortName,
            deviceId,
            deviceName: configuredDeviceNames[deviceId] ?? '',
            status,
            errorText: status === 'error' ? existing?.errorText : undefined,
            details: [port.manufacturer, `VID:${port.vendorId}`, `PID:${port.productId}`].filter(Boolean).join(' | ')
          };
          nextRows.set(rowId, row);

          const needsReprobe = !connectedState
            && !probingPaths.has(port.path)
            && !connectingPaths.has(port.path)
            && existing?.status !== 'connecting'
            && (
              !resolvedDeviceId
              || (claimedConfiguredId !== undefined)
            );
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
            status: connectedState && isPortPresent ? 'connected' : 'not_connected'
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

    const connectRow = async (row: RecoveryReconnectRow): Promise<void> => {
      if (!row.devicePath) {
        return;
      }
      if (connectingPaths.has(row.devicePath)) {
        return;
      }
      const currentlyConnected = getConnectedPyDeviceByPortPath(row.devicePath);
      if (currentlyConnected) {
        row.status = 'connected';
        updateRow(row);
        return;
      }

      connectingPaths.add(row.devicePath);
      row.status = 'connecting';
      row.errorText = undefined;
      updateRow(row);

      try {
        if (row.id.startsWith('config:')) {
          const probedId = await probeRecoveryDeviceId(row.devicePath);
          if (probedId && probedId !== row.deviceId) {
            resolvedDeviceIdByPath.set(row.devicePath, probedId);
            row.status = 'ready';
            row.errorText = undefined;
            await reconcileRows();
            return;
          }
        }

        let state: ConnectedPyDeviceState | undefined;
        try {
          state = await connectBoardForPath(row.devicePath, defaultBaudRate, true, true);
        } catch (error) {
          const message = error instanceof Error ? error.message.toLocaleLowerCase() : String(error).toLocaleLowerCase();
          const transientLock = message.includes('cannot lock port') || message.includes('resource temporarily unavailable');
          if (!transientLock) {
            throw error;
          }
          await wait(350);
          state = await connectBoardForPath(row.devicePath, defaultBaudRate, true, true);
        }
        const nextDeviceId = state?.deviceId ?? row.deviceId;
        resolvedDeviceIdByPath.set(row.devicePath, nextDeviceId);
        void updateLastKnownDevicePort(nextDeviceId, row.devicePath);
        await reconcileRows();
      } catch (error) {
        row.status = 'error';
        row.errorText = error instanceof Error ? error.message : String(error);
        updateRow(row);
      } finally {
        connectingPaths.delete(row.devicePath);
      }
    };

    const connectAll = async (): Promise<void> => {
      const candidates = [...rowsById.values()].filter(
        (row) => row.devicePath.length > 0 && (row.status === 'ready' || row.status === 'error')
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
      if (typed.type === 'reconnect' && typeof typed.rowId === 'string') {
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
    }, 2000);
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
