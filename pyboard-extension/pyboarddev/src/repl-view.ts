import * as vscode from 'vscode';
import { getConnectedBoard, getConnectedBoards, onBoardConnectionsChanged } from './commands/connect-board-command';

const openReplCommandId = 'mekatrol.pyboarddev.openrepl';
const clearReplCommandId = 'mekatrol.pyboarddev.clearrepl';
const replPanelContainerId = 'mekatrol-pyboarddev-panel';
const replViewId = 'mekatrol.pyboarddev.replView';
const replPrompt = '>>> ';
const promptFallbackDelayMs = 1200;
const maxRetainedLinesPerDevice = 2000;
const replHistoryStateKey = 'replHistoryByDevice';
const replHistoryLimitSettingKey = 'replHistoryLimit';
const defaultReplHistoryLimit = 100;

interface DeviceReplState {
  lines: string[];
  history: string[];
  hasRenderedConnectedIntro: boolean;
  promptFallbackTimer: NodeJS.Timeout | undefined;
  pendingExecution: Promise<void>;
}

interface ReplWebviewDeviceState {
  deviceId: string;
  devicePath: string;
  lines: string[];
  history: string[];
}

interface ReplWebviewState {
  devices: ReplWebviewDeviceState[];
  activeDeviceId: string | undefined;
}

interface WebviewMessage {
  type: 'submit' | 'switchTab' | 'clearHistory';
  deviceId?: string;
  command?: string;
}

class ReplViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private webviewView: vscode.WebviewView | undefined;
  private readonly devicesById = new Map<string, DeviceReplState>();
  private activeDeviceId: string | undefined;
  private readonly boardConnectionsDisposable: vscode.Disposable;
  private readonly persistedHistoryByDevice = new Map<string, string[]>();

  constructor(private readonly context: vscode.ExtensionContext) {
    this.loadPersistedHistory();
    this.boardConnectionsDisposable = onBoardConnectionsChanged((snapshots) => {
      this.reconcileConnectedDevices(snapshots);
      this.postState();
    });
    this.reconcileConnectedDevices(getConnectedBoards());
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
    for (const state of this.devicesById.values()) {
      this.clearPromptFallbackTimer(state);
    }
    this.devicesById.clear();
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

    if (message.type === 'clearHistory') {
      if (!message.deviceId) {
        return;
      }

      const state = this.devicesById.get(message.deviceId);
      if (!state) {
        return;
      }

      state.history = [];
      this.persistedHistoryByDevice.set(message.deviceId, []);
      void this.persistHistory();
      this.postState();
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
        await this.executeCommand(deviceId, command);
      });
      await state.pendingExecution;
    }
  }

  private async executeCommand(deviceId: string, command: string): Promise<void> {
    const state = this.devicesById.get(deviceId);
    if (!state) {
      return;
    }

    this.appendLine(deviceId, `${replPrompt}${command}`);
    if (command.length === 0) {
      this.appendLine(deviceId, replPrompt);
      this.postState();
      return;
    }
    this.appendHistory(deviceId, command);

    const board = getConnectedBoard(deviceId);
    if (!board) {
      this.appendLine(deviceId, '[device not connected]');
      this.postState();
      return;
    }

    try {
      const result = await board.execRawCapture(`${command}\n`);
      const combinedOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      this.appendMultiline(deviceId, combinedOutput);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.appendLine(deviceId, `[execution failed] ${message}`);
    }

    this.appendLine(deviceId, replPrompt);
    this.postState();
  }

  clearActiveRepl(): void {
    if (!this.activeDeviceId) {
      return;
    }
    this.clearDeviceRepl(this.activeDeviceId);
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

  private reconcileConnectedDevices(snapshots: ReturnType<typeof getConnectedBoards>): void {
    const connectedIds = new Set(snapshots.map((snapshot) => snapshot.deviceId));

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
          lines: [],
          history: persistedHistory,
          hasRenderedConnectedIntro: false,
          promptFallbackTimer: undefined,
          pendingExecution: Promise.resolve()
        });
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
    const snapshot = getConnectedBoards().find((item) => item.deviceId === deviceId);
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
      this.appendLine(deviceId, replPrompt);
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
      const latestSnapshot = getConnectedBoards().find((item) => item.deviceId === deviceId);
      if (!latestSnapshot || state.hasRenderedConnectedIntro) {
        return;
      }

      this.appendLine(deviceId, replPrompt);
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
      .getConfiguration('mekatrol.pyboarddev')
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
    const raw = this.context.globalState.get<unknown>(replHistoryStateKey);
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
    await this.context.globalState.update(replHistoryStateKey, payload);
  }

  private postState(): void {
    if (!this.webviewView) {
      return;
    }

    const snapshots = getConnectedBoards();
    const state: ReplWebviewState = {
      devices: snapshots.map((snapshot) => ({
        deviceId: snapshot.deviceId,
        devicePath: snapshot.devicePath,
        lines: this.devicesById.get(snapshot.deviceId)?.lines ?? [],
        history: this.devicesById.get(snapshot.deviceId)?.history ?? []
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
    .history-clear { border: none; background: transparent; color: inherit; cursor: pointer; font-size: 11px; line-height: 1; padding: 0 2px; opacity: 0.8; }
    .history-clear:hover { opacity: 1; }
    .empty { display: grid; place-items: center; height: 100%; color: var(--vscode-descriptionForeground); }
    .console { flex: 1; overflow: auto; padding: 8px 10px; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); white-space: pre-wrap; }
    .input-row { display: flex; gap: 6px; padding: 8px; border-top: 1px solid var(--vscode-panel-border); }
    .input { flex: 1; border: 1px solid var(--vscode-input-border); background: var(--vscode-input-background); color: var(--vscode-input-foreground); padding: 6px 8px; }
    .send { border: 1px solid var(--vscode-button-border); background: var(--vscode-button-background); color: var(--vscode-button-foreground); padding: 6px 10px; cursor: pointer; }
    .send:hover { background: var(--vscode-button-hoverBackground); }
  </style>
</head>
<body>
  <div class="layout">
    <div id="tabs" class="tabs"></div>
    <div id="content" class="console"></div>
    <div class="input-row">
      <input id="commandInput" class="input" type="text" spellcheck="false" placeholder="Enter REPL command and press Enter" />
      <button id="sendButton" class="send" type="button">Run</button>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let currentState = { devices: [], activeDeviceId: undefined };

    const tabsEl = document.getElementById('tabs');
    const contentEl = document.getElementById('content');
    const inputEl = document.getElementById('commandInput');
    const sendButtonEl = document.getElementById('sendButton');
    const historyCursorByDevice = new Map();
    const historyDraftByDevice = new Map();

    const getActiveDevice = () => currentState.devices.find((item) => item.deviceId === currentState.activeDeviceId);

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

    const render = () => {
      tabsEl.innerHTML = '';
      if (currentState.devices.length === 0) {
        contentEl.innerHTML = '<div class="empty">No connected devices.</div>';
        inputEl.disabled = true;
        sendButtonEl.disabled = true;
        return;
      }

      inputEl.disabled = false;
      sendButtonEl.disabled = false;

      for (const device of currentState.devices) {
        const tab = document.createElement('button');
        tab.type = 'button';
        tab.className = 'tab ' + (device.deviceId === currentState.activeDeviceId ? 'active' : '');
        tab.addEventListener('click', () => {
          vscode.postMessage({ type: 'switchTab', deviceId: device.deviceId });
        });

        const title = document.createElement('span');
        title.className = 'tab-title';
        title.textContent = device.deviceId;
        title.title = device.deviceId + ' (' + device.devicePath + ')';
        tab.appendChild(title);

        const clearHistoryButton = document.createElement('button');
        clearHistoryButton.type = 'button';
        clearHistoryButton.className = 'history-clear';
        clearHistoryButton.textContent = 'H';
        clearHistoryButton.title = 'Clear history for ' + device.deviceId;
        clearHistoryButton.addEventListener('click', (event) => {
          event.stopPropagation();
          vscode.postMessage({ type: 'clearHistory', deviceId: device.deviceId });
          historyCursorByDevice.delete(device.deviceId);
          historyDraftByDevice.delete(device.deviceId);
        });
        tab.appendChild(clearHistoryButton);

        tabsEl.appendChild(tab);
      }

      const active = getActiveDevice();
      if (!active) {
        contentEl.innerHTML = '<div class="empty">No active device.</div>';
        return;
      }

      contentEl.textContent = active.lines.join('\\n');
      contentEl.scrollTop = contentEl.scrollHeight;
      if (document.activeElement !== inputEl) {
        inputEl.focus();
      }
    };

    const submitCommand = () => {
      const active = getActiveDevice();
      if (!active) {
        return;
      }

      const command = inputEl.value;
      vscode.postMessage({ type: 'submit', deviceId: active.deviceId, command });
      inputEl.value = '';
      const submitted = command.trimEnd().length > 0;
      const expectedNextLength = (Array.isArray(active.history) ? active.history.length : 0) + (submitted ? 1 : 0);
      resetHistoryCursor(active.deviceId, expectedNextLength);
    };

    inputEl.addEventListener('input', () => {
      const active = getActiveDevice();
      if (!active) {
        return;
      }
      historyCursorByDevice.set(active.deviceId, active.history.length);
      historyDraftByDevice.set(active.deviceId, inputEl.value);
    });

    sendButtonEl.addEventListener('click', submitCommand);
    inputEl.addEventListener('keydown', (event) => {
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

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message?.type === 'state') {
        currentState = message.value;
        if (!currentState.activeDeviceId && currentState.devices.length > 0) {
          currentState.activeDeviceId = currentState.devices[0].deviceId;
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
      }
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
    })
  );

  provider.reveal();
};
