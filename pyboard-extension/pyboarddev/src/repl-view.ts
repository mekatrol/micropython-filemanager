/**
 * Module overview:
 * Implements the REPL webview panel, including per-device session state,
 * command execution, and command history.
 */
import * as path from 'path';
import * as vscode from 'vscode';
import { getConnectedPyDevice, getConnectedPyDevices, onBoardConnectionsChanged } from './commands/connect-board-command';
import { configurationFileName, getDeviceNames, loadConfiguration, onPyDeviceConfigurationUpdated } from './utils/configuration';
import { getWorkspaceCacheValue, setWorkspaceCacheValue } from './utils/workspace-cache';

const openReplCommandId = 'mekatrol.pydevice.openrepl';
const clearReplCommandId = 'mekatrol.pydevice.clearrepl';
const clearReplHistoryCommandId = 'mekatrol.pydevice.clearreplhistory';
const replPanelContainerId = 'mekatrol-pydevice-panel';
const replViewId = 'mekatrol.pydevice.replView';
const replPrompt = '>>> ';
const promptFallbackDelayMs = 1200;
const maxRetainedLinesPerDevice = 2000;
const replHistoryStateKey = 'replHistoryByDevice';
const replHistoryLimitSettingKey = 'replHistoryLimit';
const defaultReplHistoryLimit = 100;
const reopenPortDelayMs = 1000;

interface DeviceReplState {
  devicePath: string;
  lines: string[];
  history: string[];
  isExecuting: boolean;
  isPortRestarting: boolean;
  hasRenderedConnectedIntro: boolean;
  promptFallbackTimer: NodeJS.Timeout | undefined;
  pendingExecution: Promise<void>;
}

interface ReplWebviewDeviceState {
  deviceId: string;
  displayName: string;
  devicePath: string;
  portLabel: string;
  lines: string[];
  history: string[];
  isExecuting: boolean;
  isPortRestarting: boolean;
}

interface ReplWebviewState {
  devices: ReplWebviewDeviceState[];
  activeDeviceId: string | undefined;
}

interface WebviewMessage {
  type: 'submit' | 'switchTab' | 'interrupt' | 'sendControl' | 'reopenPort';
  deviceId?: string;
  command?: string;
  control?: 'interrupt' | 'softReset' | 'pasteMode';
}

class ReplViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private webviewView: vscode.WebviewView | undefined;
  private readonly devicesById = new Map<string, DeviceReplState>();
  private activeDeviceId: string | undefined;
  private readonly boardConnectionsDisposable: vscode.Disposable;
  private readonly configurationUpdatedDisposable: vscode.Disposable;
  private readonly configurationSavedDisposable: vscode.Disposable;
  private readonly persistedHistoryByDevice = new Map<string, string[]>();
  private deviceNames: Record<string, string> = {};

  constructor(private readonly context: vscode.ExtensionContext) {
    this.loadPersistedHistory();
    this.boardConnectionsDisposable = onBoardConnectionsChanged((snapshots) => {
      this.reconcileConnectedDevices(snapshots);
      this.postState();
    });
    this.configurationUpdatedDisposable = onPyDeviceConfigurationUpdated((configuration) => {
      this.deviceNames = getDeviceNames(configuration);
      this.postState();
    });
    this.configurationSavedDisposable = vscode.workspace.onDidSaveTextDocument((document) => {
      if (path.basename(document.uri.fsPath) !== path.basename(configurationFileName)) {
        return;
      }
      void this.reloadDeviceNames();
    });
    this.reconcileConnectedDevices(getConnectedPyDevices());
    void this.reloadDeviceNames();
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.webviewView = webviewView;
    webviewView.webview.options = {
      enableScripts: true
    };
    webviewView.webview.html = this.getWebviewHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage(
      (message: WebviewMessage) => {
        void this.handleWebviewMessage(message);
      },
      undefined,
      this.context.subscriptions
    );

    this.postState();
  }

  dispose(): void {
    this.boardConnectionsDisposable.dispose();
    this.configurationUpdatedDisposable.dispose();
    this.configurationSavedDisposable.dispose();
    for (const state of this.devicesById.values()) {
      this.clearPromptFallbackTimer(state);
    }
    this.devicesById.clear();
  }

  private async reloadDeviceNames(): Promise<void> {
    const configuration = await loadConfiguration();
    this.deviceNames = getDeviceNames(configuration);
    this.postState();
  }

  private getDeviceDisplayName(deviceId: string): string {
    const name = this.deviceNames[deviceId]?.trim();
    return name && name.length > 0 ? name : deviceId;
  }

  private getPortLabel(devicePath: string): string {
    const base = path.basename(devicePath);
    const withoutTtyPrefix = base.replace(/^tty/i, '');
    const shortBase = withoutTtyPrefix.length > 0 ? withoutTtyPrefix : base;
    const dir = path.dirname(devicePath);
    if (!dir || dir === '.') {
      return shortBase;
    }
    return `${dir}/${shortBase}`;
  }

  reveal(): void {
    if (this.webviewView) {
      this.webviewView.show(true);
      return;
    }

    void vscode.commands.executeCommand(`workbench.view.extension.${replPanelContainerId}`);
  }

  private async handleWebviewMessage(message: WebviewMessage): Promise<void> {
    if (message.type === 'switchTab') {
      if (message.deviceId && this.devicesById.has(message.deviceId)) {
        this.activeDeviceId = message.deviceId;
        this.postState();
      }
      return;
    }

    if (message.type === 'submit') {
      const deviceId = message.deviceId;
      const command = (message.command ?? '').trimEnd();
      if (!deviceId || !this.devicesById.has(deviceId)) {
        return;
      }

      const state = this.devicesById.get(deviceId);
      if (!state) {
        return;
      }

      state.pendingExecution = state.pendingExecution.then(async () => {
        state.isExecuting = true;
        this.postState();
        try {
          await this.executeCommand(deviceId, command);
        } finally {
          state.isExecuting = false;
          this.postState();
        }
      });
      await state.pendingExecution;
      return;
    }

    if (message.type === 'reopenPort') {
      const deviceId = message.deviceId;
      if (!deviceId || !this.devicesById.has(deviceId)) {
        return;
      }

      const state = this.devicesById.get(deviceId);
      if (!state) {
        return;
      }

      state.pendingExecution = state.pendingExecution.then(async () => {
        const board = getConnectedPyDevice(deviceId);
        if (!board) {
          this.appendLine(deviceId, '[device not connected]');
          this.postState();
          return;
        }

        state.isPortRestarting = true;
        this.postState();
        try {
          await board.close();
          this.appendLine(deviceId, '[serial port closed]');
          await new Promise((resolve) => setTimeout(resolve, reopenPortDelayMs));
          await board.open();
          this.appendLine(deviceId, '[serial port reopened]');

          try {
            const runtimeInfo = await board.probeDeviceInfo(2500);
            this.appendLine(deviceId, runtimeInfo.banner);
            this.appendLine(deviceId, 'Type "help()" for more information.');
          } catch {
            // Port reopen can succeed even if runtime probe does not.
          }
        } catch (error) {
          const messageText = error instanceof Error ? error.message : String(error);
          this.appendLine(deviceId, `[reopen failed] ${messageText}`);
        } finally {
          state.isPortRestarting = false;
          this.postState();
        }
      });
      await state.pendingExecution;
      return;
    }

    if (message.type === 'interrupt' || message.type === 'sendControl') {
      const deviceId = message.deviceId;
      if (!deviceId || !this.devicesById.has(deviceId)) {
        return;
      }

      const board = getConnectedPyDevice(deviceId);
      if (!board) {
        this.appendLine(deviceId, '[device not connected]');
        this.postState();
        return;
      }

      const control = message.type === 'interrupt' ? 'interrupt' : message.control;
      const controlMap: Record<NonNullable<WebviewMessage['control']>, { byte: string; label: string; isSoftReset?: boolean }> = {
        interrupt: { byte: '\x03', label: 'Ctrl-C' },
        softReset: { byte: '\x04', label: 'Ctrl-D', isSoftReset: true },
        pasteMode: { byte: '\x05', label: 'Ctrl-E' }
      };
      
      const controlSpec = control ? controlMap[control] : undefined;
      if (!controlSpec) {
        return;
      }

      try {
        if (controlSpec.isSoftReset) {
          await board.softReboot();
          this.appendLine(deviceId, '[soft reboot complete]');

          try {
            const runtimeInfo = await board.probeDeviceInfo(2500);
            this.appendLine(deviceId, runtimeInfo.banner);
            this.appendLine(deviceId, 'Type "help()" for more information.');
          } catch {
            // Board rebooted, but runtime banner probe may fail on some transports/boards.
          }
        } else {
          await board.sendText(controlSpec.byte, { drain: false });
          this.appendLine(deviceId, `[sent ${controlSpec.label}]`);
        }
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error);
        this.appendLine(deviceId, `[${controlSpec.label} failed] ${messageText}`);
      }
      this.postState();
    }
  }

  private async executeCommand(deviceId: string, command: string): Promise<void> {
    const state = this.devicesById.get(deviceId);
    if (!state) {
      return;
    }

    this.appendLine(deviceId, `${replPrompt}${command}`);
    if (command.length === 0) {
      this.postState();
      return;
    }
    this.appendHistory(deviceId, command);

    const board = getConnectedPyDevice(deviceId);
    if (!board) {
      this.appendLine(deviceId, '[device not connected]');
      this.postState();
      return;
    }

    try {
      const result = await board.execute(`${command}\n`);
      const combinedOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      this.appendMultiline(deviceId, combinedOutput);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.appendLine(deviceId, `[execution failed] ${message}`);
    }

    this.postState();
  }

  clearActiveRepl(): void {
    if (!this.activeDeviceId) {
      return;
    }
    this.clearDeviceRepl(this.activeDeviceId);
  }

  clearActiveHistory(): void {
    if (!this.activeDeviceId) {
      return;
    }
    this.clearDeviceHistory(this.activeDeviceId);
  }

  private clearDeviceRepl(deviceId: string): void {
    const state = this.devicesById.get(deviceId);
    if (!state) {
      return;
    }

    state.lines = [];
    state.hasRenderedConnectedIntro = false;
    this.renderConnectedIntroForDevice(deviceId);
    this.postState();
  }

  private clearDeviceHistory(deviceId: string): void {
    const state = this.devicesById.get(deviceId);
    if (!state) {
      return;
    }

    state.history = [];
    this.persistedHistoryByDevice.set(deviceId, []);
    void this.persistHistory();
    this.postState();
  }

  private reconcileConnectedDevices(snapshots: ReturnType<typeof getConnectedPyDevices>): void {
    const connectedIds = new Set(snapshots.map((snapshot) => snapshot.deviceId));
    const snapshotById = new Map(snapshots.map((snapshot) => [snapshot.deviceId, snapshot]));

    // If a device ID was promoted for the same serial port path, preserve REPL state/history
    // by moving the existing state entry to the new device ID key.
    for (const snapshot of snapshots) {
      if (this.devicesById.has(snapshot.deviceId)) {
        continue;
      }

      const previousEntry = [...this.devicesById.entries()].find(([existingId, state]) =>
        !connectedIds.has(existingId)
        && state.devicePath === snapshot.devicePath
        && !snapshotById.has(existingId)
      );
      if (!previousEntry) {
        continue;
      }

      const [previousDeviceId, previousState] = previousEntry;
      this.devicesById.delete(previousDeviceId);
      previousState.devicePath = snapshot.devicePath;
      this.devicesById.set(snapshot.deviceId, previousState);

      const persistedHistory = this.persistedHistoryByDevice.get(previousDeviceId);
      if (persistedHistory) {
        this.persistedHistoryByDevice.delete(previousDeviceId);
        this.persistedHistoryByDevice.set(snapshot.deviceId, persistedHistory);
      }

      if (this.activeDeviceId === previousDeviceId) {
        this.activeDeviceId = snapshot.deviceId;
      }
    }

    for (const existingId of this.devicesById.keys()) {
      if (!connectedIds.has(existingId)) {
        const state = this.devicesById.get(existingId);
        if (state) {
          this.clearPromptFallbackTimer(state);
        }
        this.devicesById.delete(existingId);
      }
    }

    for (const snapshot of snapshots) {
      if (!this.devicesById.has(snapshot.deviceId)) {
        const persistedHistory = this.getPersistedHistoryForDevice(snapshot.deviceId);
        this.devicesById.set(snapshot.deviceId, {
          devicePath: snapshot.devicePath,
          lines: [],
          history: persistedHistory,
          isExecuting: false,
          isPortRestarting: false,
          hasRenderedConnectedIntro: false,
          promptFallbackTimer: undefined,
          pendingExecution: Promise.resolve()
        });
      } else {
        const state = this.devicesById.get(snapshot.deviceId);
        if (state) {
          state.devicePath = snapshot.devicePath;
        }
      }

      this.renderConnectedIntroForDevice(snapshot.deviceId);
    }

    if (this.activeDeviceId && !this.devicesById.has(this.activeDeviceId)) {
      this.activeDeviceId = undefined;
    }

    if (!this.activeDeviceId && snapshots.length > 0) {
      this.activeDeviceId = snapshots[0].deviceId;
    }
  }

  private renderConnectedIntroForDevice(deviceId: string): void {
    const state = this.devicesById.get(deviceId);
    const snapshot = getConnectedPyDevices().find((item) => item.deviceId === deviceId);
    if (!state || !snapshot) {
      return;
    }

    if (state.hasRenderedConnectedIntro) {
      return;
    }

    if (snapshot.runtimeInfo) {
      this.clearPromptFallbackTimer(state);
      this.appendLine(deviceId, snapshot.runtimeInfo.banner);
      this.appendLine(deviceId, 'Type "help()" for more information.');
      state.hasRenderedConnectedIntro = true;
      return;
    }

    if (state.promptFallbackTimer) {
      return;
    }

    state.promptFallbackTimer = setTimeout(() => {
      state.promptFallbackTimer = undefined;
      if (!this.devicesById.has(deviceId)) {
        return;
      }
      const latestSnapshot = getConnectedPyDevices().find((item) => item.deviceId === deviceId);
      if (!latestSnapshot || state.hasRenderedConnectedIntro) {
        return;
      }

      state.hasRenderedConnectedIntro = true;
      this.postState();
    }, promptFallbackDelayMs);
  }

  private clearPromptFallbackTimer(state: DeviceReplState): void {
    if (!state.promptFallbackTimer) {
      return;
    }

    clearTimeout(state.promptFallbackTimer);
    state.promptFallbackTimer = undefined;
  }

  private appendMultiline(deviceId: string, text: string): void {
    const normalised = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (!normalised) {
      return;
    }

    const lines = normalised.split('\n');
    const trailingBlank = lines.length > 0 && lines[lines.length - 1] === '';
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line === '' && trailingBlank && i === lines.length - 1) {
        continue;
      }
      this.appendLine(deviceId, line);
    }
  }

  private appendLine(deviceId: string, line: string): void {
    const state = this.devicesById.get(deviceId);
    if (!state) {
      return;
    }

    state.lines.push(line);
    if (state.lines.length > maxRetainedLinesPerDevice) {
      state.lines.splice(0, state.lines.length - maxRetainedLinesPerDevice);
    }
  }

  private appendHistory(deviceId: string, command: string): void {
    const state = this.devicesById.get(deviceId);
    if (!state) {
      return;
    }

    const next = [...state.history, command];
    const limit = this.getHistoryLimit();
    state.history = this.applyHistoryLimit(next, limit);
    this.persistedHistoryByDevice.set(deviceId, [...state.history]);
    void this.persistHistory();
  }

  private getHistoryLimit(): number {
    const configured = vscode.workspace
      .getConfiguration('mekatrol.pydevice')
      .get<number>(replHistoryLimitSettingKey, defaultReplHistoryLimit);
    if (!Number.isFinite(configured) || configured < 0) {
      return defaultReplHistoryLimit;
    }

    return Math.floor(configured);
  }

  private applyHistoryLimit(history: string[], limit: number): string[] {
    if (limit <= 0) {
      return [];
    }
    if (history.length <= limit) {
      return history;
    }
    return history.slice(history.length - limit);
  }

  private getPersistedHistoryForDevice(deviceId: string): string[] {
    const limit = this.getHistoryLimit();
    const stored = this.persistedHistoryByDevice.get(deviceId) ?? [];
    const trimmed = this.applyHistoryLimit(stored, limit);
    if (trimmed.length !== stored.length) {
      this.persistedHistoryByDevice.set(deviceId, trimmed);
      void this.persistHistory();
    }
    return [...trimmed];
  }

  private loadPersistedHistory(): void {
    const raw = getWorkspaceCacheValue<unknown>(replHistoryStateKey);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return;
    }

    const limit = this.getHistoryLimit();
    for (const [deviceId, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof deviceId !== 'string' || !Array.isArray(value)) {
        continue;
      }

      const entries = value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trimEnd())
        .filter((item) => item.length > 0);
      this.persistedHistoryByDevice.set(deviceId, this.applyHistoryLimit(entries, limit));
    }
  }

  private async persistHistory(): Promise<void> {
    const payload = Object.fromEntries(this.persistedHistoryByDevice.entries());
    await setWorkspaceCacheValue(replHistoryStateKey, payload);
  }

  private postState(): void {
    if (!this.webviewView) {
      return;
    }

    const snapshots = getConnectedPyDevices();
    const state: ReplWebviewState = {
      devices: snapshots.map((snapshot) => ({
        deviceId: snapshot.deviceId,
        displayName: this.getDeviceDisplayName(snapshot.deviceId),
        devicePath: snapshot.devicePath,
        portLabel: this.getPortLabel(snapshot.devicePath),
        lines: this.devicesById.get(snapshot.deviceId)?.lines ?? [],
        history: this.devicesById.get(snapshot.deviceId)?.history ?? [],
        isExecuting: this.devicesById.get(snapshot.deviceId)?.isExecuting ?? false,
        isPortRestarting: this.devicesById.get(snapshot.deviceId)?.isPortRestarting ?? false
      })),
      activeDeviceId: this.activeDeviceId
    };

    this.webviewView.webview.postMessage({ type: 'state', value: state });
  }

  private getWebviewHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    :root { color-scheme: light dark; }
    body { margin: 0; font-family: var(--vscode-editor-font-family); background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); }
    .layout { display: flex; flex-direction: column; height: 100vh; }
    .tabs { display: flex; align-items: center; gap: 4px; padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border); overflow-x: auto; }
    .tab { display: inline-flex; align-items: center; gap: 8px; border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 4px 8px; background: var(--vscode-editor-background); cursor: pointer; user-select: none; }
    .tab.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); border-color: var(--vscode-list-activeSelectionBackground); }
    .tab-title { white-space: nowrap; max-width: 260px; text-overflow: ellipsis; overflow: hidden; }
    .empty { display: grid; place-items: center; height: 100%; color: var(--vscode-descriptionForeground); }
    .console { flex: 1; overflow: auto; padding: 8px 10px; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
    .output { margin: 0; white-space: pre-wrap; word-break: break-word; }
    .prompt-row { display: flex; align-items: center; gap: 6px; margin-top: 2px; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
    .prompt-row.disabled { opacity: 0.6; }
    .prompt-label { color: var(--vscode-editor-foreground); user-select: text; }
    .input { flex: 1; border: none; outline: none; background: transparent; color: var(--vscode-editor-foreground); padding: 0; font-family: inherit; font-size: inherit; }
    .busy { display: inline-flex; align-items: center; gap: 6px; color: var(--vscode-descriptionForeground); font-size: 11px; user-select: none; }
    .busy.hidden { display: none; }
    .spinner {
      width: 11px;
      height: 11px;
      border: 2px solid var(--vscode-descriptionForeground);
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .toolbar { display: flex; align-items: center; gap: 6px; border-bottom: 1px solid var(--vscode-panel-border); padding: 6px 8px; }
    .toolbar-button {
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      padding: 2px 10px;
      cursor: pointer;
      font-size: 11px;
    }
    .toolbar-button:disabled { opacity: 0.6; cursor: default; }
  </style>
</head>
<body>
  <div class="layout">
    <div id="tabs" class="tabs"></div>
    <div id="toolbar" class="toolbar">
      <button id="ctrlCButton" class="toolbar-button" type="button" aria-label="Send Ctrl-C to device">Ctrl-C Interrupt</button>
      <button id="ctrlDButton" class="toolbar-button" type="button" aria-label="Send Ctrl-D to device">Ctrl-D Soft reset</button>
      <button id="ctrlEButton" class="toolbar-button" type="button" aria-label="Send Ctrl-E to device">Ctrl-E Paste mode</button>
      <button id="reopenPortButton" class="toolbar-button" type="button" aria-label="Close and reopen serial port" style="display:none;">Reopen Port</button>
    </div>
    <div id="content" class="console">
      <pre id="output" class="output"></pre>
      <div id="promptRow" class="prompt-row">
        <span class="prompt-label">>>> </span>
        <input id="commandInput" class="input" type="text" spellcheck="false" aria-label="REPL command input" />
        <span id="busyIndicator" class="busy hidden" aria-live="polite"><span class="spinner"></span>Running...</span>
      </div>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let currentState = { devices: [], activeDeviceId: undefined };

    const tabsEl = document.getElementById('tabs');
    const contentEl = document.getElementById('content');
    const outputEl = document.getElementById('output');
    const promptRowEl = document.getElementById('promptRow');
    const inputEl = document.getElementById('commandInput');
    const busyIndicatorEl = document.getElementById('busyIndicator');
    const ctrlCButtonEl = document.getElementById('ctrlCButton');
    const ctrlDButtonEl = document.getElementById('ctrlDButton');
    const ctrlEButtonEl = document.getElementById('ctrlEButton');
    const reopenPortButtonEl = document.getElementById('reopenPortButton');
    const historyCursorByDevice = new Map();
    const historyDraftByDevice = new Map();
    const pendingEchoByDevice = new Map();
    let deferredState;

    const getActiveDevice = () => currentState.devices.find((item) => item.deviceId === currentState.activeDeviceId);

    const renderReopenPortButton = (active) => {
      if (!active) {
        reopenPortButtonEl.textContent = 'Reopen Port';
        return;
      }

      const portLabel = active.portLabel || active.devicePath || 'Port';
      if (active.isPortRestarting) {
        reopenPortButtonEl.innerHTML = '<span class="spinner"></span> Reopening ' + portLabel + '...';
        return;
      }

      reopenPortButtonEl.textContent = 'Reopen ' + portLabel;
    };

    const resetHistoryCursor = (deviceId, nextLength) => {
      const active = currentState.devices.find((item) => item.deviceId === deviceId);
      const length = typeof nextLength === 'number' ? nextLength : (active?.history?.length ?? 0);
      historyCursorByDevice.set(deviceId, length);
      historyDraftByDevice.set(deviceId, '');
    };

    const navigateHistory = (direction) => {
      const active = getActiveDevice();
      if (!active) {
        return;
      }

      const history = Array.isArray(active.history) ? active.history : [];
      if (history.length === 0) {
        return;
      }

      const deviceId = active.deviceId;
      if (!historyCursorByDevice.has(deviceId)) {
        historyCursorByDevice.set(deviceId, history.length);
      }
      if (!historyDraftByDevice.has(deviceId)) {
        historyDraftByDevice.set(deviceId, inputEl.value);
      }

      let nextCursor = historyCursorByDevice.get(deviceId);
      if (direction < 0) {
        nextCursor = Math.max(0, nextCursor - 1);
      } else {
        nextCursor = Math.min(history.length, nextCursor + 1);
      }
      historyCursorByDevice.set(deviceId, nextCursor);

      if (nextCursor === history.length) {
        inputEl.value = historyDraftByDevice.get(deviceId) ?? '';
        return;
      }

      inputEl.value = history[nextCursor] ?? '';
    };

    const getRenderLines = (active) => {
      const lines = Array.isArray(active?.lines) ? [...active.lines] : [];
      const pending = pendingEchoByDevice.get(active?.deviceId);
      if (typeof pending === 'string' && pending.length > 0) {
        lines.push('>>> ' + pending);
      }
      return lines;
    };

    const hasActiveSelectionInConsole = () => {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        return false;
      }
      const anchor = selection.getRangeAt(0).commonAncestorContainer;
      return contentEl.contains(anchor);
    };

    const applyState = (nextState) => {
      currentState = nextState;
      if (!currentState.activeDeviceId && currentState.devices.length > 0) {
        currentState.activeDeviceId = currentState.devices[0].deviceId;
      }
      for (const device of currentState.devices) {
        const pending = pendingEchoByDevice.get(device.deviceId);
        if (typeof pending !== 'string' || pending.length === 0) {
          continue;
        }
        const commandLine = '>>> ' + pending;
        if (Array.isArray(device.lines) && device.lines.includes(commandLine)) {
          pendingEchoByDevice.delete(device.deviceId);
        }
      }
      const active = getActiveDevice();
      if (active) {
        const cursor = historyCursorByDevice.get(active.deviceId);
        const maxCursor = active.history.length;
        if (typeof cursor === 'number' && cursor > maxCursor) {
          historyCursorByDevice.set(active.deviceId, maxCursor);
        }
      }
      render();
    };

    const render = () => {
      tabsEl.innerHTML = '';
      if (currentState.devices.length === 0) {
        outputEl.textContent = 'No connected devices.';
        promptRowEl.classList.add('disabled');
        inputEl.disabled = true;
        busyIndicatorEl.classList.add('hidden');
        ctrlCButtonEl.disabled = true;
        ctrlDButtonEl.disabled = true;
        ctrlEButtonEl.disabled = true;
        reopenPortButtonEl.disabled = true;
        renderReopenPortButton(undefined);
        if (!hasActiveSelectionInConsole()) {
          contentEl.scrollTop = contentEl.scrollHeight;
        }
        return;
      }

      promptRowEl.classList.remove('disabled');
      inputEl.disabled = false;
      ctrlCButtonEl.disabled = false;
      ctrlDButtonEl.disabled = false;
      ctrlEButtonEl.disabled = false;
      reopenPortButtonEl.disabled = false;

      for (const device of currentState.devices) {
        const tab = document.createElement('button');
        tab.type = 'button';
        tab.className = 'tab ' + (device.deviceId === currentState.activeDeviceId ? 'active' : '');
        tab.addEventListener('click', () => {
          vscode.postMessage({ type: 'switchTab', deviceId: device.deviceId });
        });

        const title = document.createElement('span');
        title.className = 'tab-title';
        title.textContent = device.displayName || device.deviceId;
        title.title = (device.displayName || device.deviceId) + ' (' + device.devicePath + ')';
        tab.appendChild(title);

        tabsEl.appendChild(tab);
      }

      const active = getActiveDevice();
      if (!active) {
        outputEl.textContent = 'No active device.';
        promptRowEl.classList.add('disabled');
        inputEl.disabled = true;
        busyIndicatorEl.classList.add('hidden');
        ctrlCButtonEl.disabled = true;
        ctrlDButtonEl.disabled = true;
        ctrlEButtonEl.disabled = true;
        reopenPortButtonEl.disabled = true;
        renderReopenPortButton(undefined);
        return;
      }

      const isBusy = !!active.isExecuting || !!active.isPortRestarting;
      const isRestarting = !!active.isPortRestarting;
      inputEl.disabled = isBusy;
      if (isBusy) {
        busyIndicatorEl.classList.remove('hidden');
      } else {
        busyIndicatorEl.classList.add('hidden');
      }
      ctrlCButtonEl.disabled = isRestarting;
      ctrlDButtonEl.disabled = isRestarting;
      ctrlEButtonEl.disabled = isRestarting;
      reopenPortButtonEl.disabled = isRestarting;
      renderReopenPortButton(active);

      outputEl.textContent = getRenderLines(active).join('\\n');
      if (!hasActiveSelectionInConsole()) {
        contentEl.scrollTop = contentEl.scrollHeight;
      }
      if (!isBusy && !hasActiveSelectionInConsole() && document.activeElement !== inputEl) {
        inputEl.focus();
      }
    };

    const submitCommand = () => {
      const active = getActiveDevice();
      if (!active) {
        return;
      }
      if (active.isExecuting || active.isPortRestarting) {
        return;
      }

      const command = inputEl.value;
      const cleanedCommand = command.replace(/\u0003/g, '');
      const trimmedCommand = cleanedCommand.trimEnd();
      if (trimmedCommand.length > 0) {
        pendingEchoByDevice.set(active.deviceId, trimmedCommand);
      }
      vscode.postMessage({ type: 'submit', deviceId: active.deviceId, command: cleanedCommand });
      inputEl.value = '';
      const submitted = trimmedCommand.length > 0;
      const expectedNextLength = (Array.isArray(active.history) ? active.history.length : 0) + (submitted ? 1 : 0);
      resetHistoryCursor(active.deviceId, expectedNextLength);
      render();
    };

    inputEl.addEventListener('input', () => {
      const active = getActiveDevice();
      if (!active) {
        return;
      }
      historyCursorByDevice.set(active.deviceId, active.history.length);
      historyDraftByDevice.set(active.deviceId, inputEl.value);
    });

    inputEl.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
        // Preserve native copy behavior and prevent accidental Ctrl-C passthrough.
        event.stopPropagation();
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        navigateHistory(-1);
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        navigateHistory(1);
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        submitCommand();
      }
    });

    window.addEventListener('keydown', (event) => {
      const active = getActiveDevice();
      if (!active) {
        return;
      }
      if (active.isExecuting || active.isPortRestarting) {
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
        // Keep Ctrl-C available for copy in REPL output/input.
        return;
      }

      if (event.target === inputEl) {
        return;
      }

      if (event.key === 'Enter') {
        event.preventDefault();
        submitCommand();
        return;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        inputEl.focus();
        navigateHistory(-1);
        return;
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        inputEl.focus();
        navigateHistory(1);
        return;
      }

      if (event.key === 'Backspace') {
        event.preventDefault();
        inputEl.focus();
        inputEl.value = inputEl.value.slice(0, -1);
        return;
      }

      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        inputEl.focus();
        inputEl.value += event.key;
      }
    });

    const sendControl = (control) => {
      const active = getActiveDevice();
      if (!active) {
        return;
      }
      vscode.postMessage({ type: 'sendControl', deviceId: active.deviceId, control });
    };

    ctrlCButtonEl.addEventListener('click', () => sendControl('interrupt'));
    ctrlDButtonEl.addEventListener('click', () => sendControl('softReset'));
    ctrlEButtonEl.addEventListener('click', () => sendControl('pasteMode'));
    reopenPortButtonEl.addEventListener('click', () => {
      const active = getActiveDevice();
      if (!active || active.isPortRestarting) {
        return;
      }
      vscode.postMessage({ type: 'reopenPort', deviceId: active.deviceId });
    });

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message?.type === 'state') {
        if (hasActiveSelectionInConsole()) {
          deferredState = message.value;
          return;
        }
        applyState(message.value);
      }
    });

    document.addEventListener('selectionchange', () => {
      if (!deferredState || hasActiveSelectionInConsole()) {
        return;
      }
      const nextState = deferredState;
      deferredState = undefined;
      applyState(nextState);
    });
  </script>
</body>
</html>`;
  }
}

const getNonce = (): string => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let i = 0; i < 32; i += 1) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
};

export const initReplView = (context: vscode.ExtensionContext): void => {
  const provider = new ReplViewProvider(context);

  context.subscriptions.push(
    provider,
    vscode.window.registerWebviewViewProvider(replViewId, provider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand(openReplCommandId, () => {
      provider.reveal();
    }),
    vscode.commands.registerCommand(clearReplCommandId, () => {
      provider.clearActiveRepl();
    }),
    vscode.commands.registerCommand(clearReplHistoryCommandId, () => {
      provider.clearActiveHistory();
    })
  );

  provider.reveal();
};
