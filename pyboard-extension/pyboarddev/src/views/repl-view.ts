/**
 * Module overview:
 * Implements the REPL webview panel, including per-device session state,
 * command execution, and command history.
 */
import * as path from 'path';
import * as vscode from 'vscode';
import { getConnectedPyDevice, getConnectedPyDevices, onBoardConnectionsChanged } from '../commands/connect-board-command';
import { pyDeviceTimeoutSettings } from '../constants/timeout-constants';
import { createWebviewNonce, escapeJsonForHtml, getWebviewAssetUri, loadWebviewTemplate } from '../utils/webview-template';
import { configurationFileName, getDeviceNames, loadConfiguration, onPyDeviceConfigurationUpdated } from '../utils/configuration';
import { getTimeoutSettingMs } from '../utils/timeout-settings';
import { getWorkspaceCacheValue, setWorkspaceCacheValue } from '../utils/workspace-cache';
import { t } from '../utils/i18n';

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
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webviews')
      ]
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
            const runtimeInfo = await board.probeDeviceInfo(getTimeoutSettingMs(pyDeviceTimeoutSettings.pythonProbeRuntimeInfo));
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
            const runtimeInfo = await board.probeDeviceInfo(getTimeoutSettingMs(pyDeviceTimeoutSettings.pythonProbeRuntimeInfo));
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
    const nonce = createWebviewNonce();
    const template = loadWebviewTemplate(this.context.extensionUri, 'repl');
    const cssUri = getWebviewAssetUri(webview, this.context.extensionUri, 'repl', 'index.css');
    const scriptUri = getWebviewAssetUri(webview, this.context.extensionUri, 'repl', 'index.js');
    const initialState = escapeJsonForHtml({
      i18n: {
        noConnectedDevices: t('No connected devices.'),
        noActiveDevice: t('No active device.'),
        reopenPort: t('Reopen Port'),
        reopenPortNamed: t('Reopen {0}'),
        reopeningPortNamed: t('Reopening {0}...'),
        portLabelFallback: t('Port')
      }
    });

    return template
      .replace('__CSP_SOURCE__', webview.cspSource)
      .replaceAll('__NONCE__', nonce)
      .replace('__CSS_URI__', cssUri.toString())
      .replace('__SCRIPT_URI__', scriptUri.toString())
      .replace('__INITIAL_STATE__', initialState)
      .replace('__CTRL_C_ARIA__', t('Send Ctrl-C to device'))
      .replace('__CTRL_D_ARIA__', t('Send Ctrl-D to device'))
      .replace('__CTRL_E_ARIA__', t('Send Ctrl-E to device'))
      .replace('__REOPEN_PORT_ARIA__', t('Close and reopen serial port'))
      .replace('__CTRL_C__', t('Ctrl-C Interrupt'))
      .replace('__CTRL_D__', t('Ctrl-D Soft reset'))
      .replace('__CTRL_E__', t('Ctrl-E Paste mode'))
      .replace('__REOPEN_PORT__', t('Reopen Port'))
      .replace('__REPL_INPUT_ARIA__', t('REPL command input'))
      .replace('__RUNNING__', t('Running...'));
  }
}

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
