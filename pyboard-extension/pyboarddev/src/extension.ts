/**
 * Module overview:
 * Extension activation/deactivation entrypoint that wires up commands,
 * views, background services, and lifecycle cleanup.
 */
import * as vscode from 'vscode';
import { initOutputChannel, logChannelOutput as logChannelOutput } from './logging/output-channel';
import { initCreateConfigCommand } from './commands/create-config-command';
import { initAutoDetectDevicesCommand } from './commands/auto-detect-devices-command';
import {
  closeAllConnectedPyDevices,
  initConnectBoardCommand,
  initConnectionStateMonitor,
  initRecoveryConnectCommand,
  initDisconnectBoardCommand,
  initSoftRebootBoardCommand,
  initSetAutoReconnectCommand,
  initToggleBoardConnectionCommand,
  tryReconnectBoardOnStartup
} from './commands/connect-board-command';
import { initDeviceSyncExplorer } from './views/device-sync-explorer';
import { initPyDeviceDebug } from './debug/py-device-debug';
import { initReplView } from './views/repl-view';
import { initExtensionStatusView } from './views/extension-status-view';
import { getWorkspaceCacheValue, initialiseWorkspaceCache, loggerAutoStartCacheKey, setWorkspaceCacheValue } from './utils/workspace-cache';
import { initialisePyDeviceController, stopPyDeviceController } from './devices/controller/py-device-controller-singleton';
import { FileWatcher } from './utils/file-watcher';
import { disposePyDeviceLogger, initPyDeviceLogger, logPyDeviceLogger } from './logging/pydevice-logger';
import { initSetLoggerAutoStartCommand } from './commands/set-logger-autostart-command';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export const activate = async (context: vscode.ExtensionContext) => {
  // Initialise output channel for logging
  initOutputChannel();
  logChannelOutput('Mekatrol PyDevice activated...', false);
  await initialiseWorkspaceCache();
  const storedLoggerAutoStart = getWorkspaceCacheValue<boolean>(loggerAutoStartCacheKey);
  if (storedLoggerAutoStart === undefined) {
    await setWorkspaceCacheValue(loggerAutoStartCacheKey, true);
  }

  let fileWatcherLoggerSubscription: vscode.Disposable | undefined;
  let fileWatcherOutputLogSubscription: vscode.Disposable | undefined;
  const setLoggerLiveState = (enabled: boolean): void => {
    if (enabled) {
      initPyDeviceLogger();
      if (!fileWatcherLoggerSubscription) {
        fileWatcherLoggerSubscription = fileWatcher.onDidLog((entry) => {
          logPyDeviceLogger(entry.message);
        });
      }
      logPyDeviceLogger('Mekatrol PyDevice activated.');
      return;
    }

    fileWatcherLoggerSubscription?.dispose();
    fileWatcherLoggerSubscription = undefined;
    disposePyDeviceLogger();
  };

  try {
    await initialisePyDeviceController();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logChannelOutput(`PyDeviceController startup failed: ${reason}`, true);
  }

  const fileWatcher = new FileWatcher({
    excludedPaths: ['.vscode', '.pydevice']
  });
  fileWatcherOutputLogSubscription = fileWatcher.onDidLog((entry) => {
    logChannelOutput(entry.message, entry.isError);
  });
  fileWatcher.start();
  const loggerAutoStart = getWorkspaceCacheValue<boolean>(loggerAutoStartCacheKey) ?? true;
  setLoggerLiveState(loggerAutoStart);

  context.subscriptions.push(new vscode.Disposable(() => {
    fileWatcherLoggerSubscription?.dispose();
    fileWatcherLoggerSubscription = undefined;
    fileWatcherOutputLogSubscription?.dispose();
    fileWatcherOutputLogSubscription = undefined;
  }));
  context.subscriptions.push(fileWatcher);

  context.subscriptions.push({
    dispose: () => stopPyDeviceController()
  });

  // Create commands
  initCreateConfigCommand(context);
  initAutoDetectDevicesCommand(context);
  initConnectBoardCommand(context);
  initRecoveryConnectCommand(context);
  initDisconnectBoardCommand(context);
  initSoftRebootBoardCommand(context);
  initSetAutoReconnectCommand(context);
  initSetLoggerAutoStartCommand(context, (enabled) => setLoggerLiveState(enabled));
  initToggleBoardConnectionCommand(context);
  initConnectionStateMonitor(context);
  initReplView(context);
  await tryReconnectBoardOnStartup(context);

  initExtensionStatusView(context);

  // Init device sync explorer
  await initDeviceSyncExplorer(context, fileWatcher);

  // Init Run/Debug integration
  initPyDeviceDebug(context);

};

// This method is called when your extension is deactivated
export async function deactivate() {
  disposePyDeviceLogger();
  stopPyDeviceController();

  const hasDirtyDeviceDocuments = vscode.workspace.textDocuments.some(
    (document) => document.uri.scheme === 'pydevice-device' && document.isDirty
  );

  if (hasDirtyDeviceDocuments) {
    return;
  }

  await closeAllConnectedPyDevices(false, true, false, false);
}
