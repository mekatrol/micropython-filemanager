/**
 * Module overview:
 * Extension activation/deactivation entrypoint that wires up commands,
 * views, background services, and lifecycle cleanup.
 */
import * as vscode from 'vscode';
import { initOutputChannel, logChannelOutput as logChannelOutput } from './output-channel';
import { initCreateConfigCommand } from './commands/create-config-command';
import { initAutoDetectDevicesCommand } from './commands/auto-detect-devices-command';
import {
  closeAllConnectedPyDevices,
  initConnectBoardCommand,
  initRecoveryConnectCommand,
  initDisconnectBoardCommand,
  initSoftRebootBoardCommand,
  initSetAutoReconnectCommand,
  initToggleBoardConnectionCommand,
  tryReconnectBoardOnStartup
} from './commands/connect-board-command';
import { initDeviceSyncExplorer } from './device-sync-explorer';
import { initPyDeviceDebug } from './py-device-debug';
import { initReplView } from './repl-view';
import { initExtensionStatusView } from './extension-status-view';
import { initialiseWorkspaceCache } from './utils/workspace-cache';
import { initialisePyDeviceController, stopPyDeviceController } from './devices/py-device-controller-singleton';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export const activate = async (context: vscode.ExtensionContext) => {
  // Initialise output channel for logging
  initOutputChannel();
  logChannelOutput('Mekatrol PyDevice activated...', false);
  await initialiseWorkspaceCache();
  try {
    await initialisePyDeviceController();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logChannelOutput(`PyDeviceController startup failed: ${reason}`, true);
  }

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
  initToggleBoardConnectionCommand(context);
  initReplView(context);
  await tryReconnectBoardOnStartup(context);

  initExtensionStatusView(context);

  // Init device sync explorer
  await initDeviceSyncExplorer(context);

  // Init Run/Debug integration
  initPyDeviceDebug(context);

};

// This method is called when your extension is deactivated
export async function deactivate() {
  stopPyDeviceController();

  const hasDirtyDeviceDocuments = vscode.workspace.textDocuments.some(
    (document) => document.uri.scheme === 'pydevice-device' && document.isDirty
  );

  if (hasDirtyDeviceDocuments) {
    return;
  }

  await closeAllConnectedPyDevices(false, true, false, false);
}

