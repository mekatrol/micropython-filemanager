import * as vscode from 'vscode';
import { initStatusBar } from './status-bar';
import { initOutputChannel, logChannelOutput as logChannelOutput } from './output-channel';
import { initCreateConfigCommand } from './commands/create-config-command';
import { initAutoDetectDevicesCommand } from './commands/auto-detect-devices-command';
import {
  closeConnectedBoard,
  initConnectBoardCommand,
  initDisconnectBoardCommand,
  initSoftRebootBoardCommand,
  initSetAutoReconnectCommand,
  initToggleBoardConnectionCommand,
  tryReconnectBoardOnStartup
} from './commands/connect-board-command';
import { initDeviceMirrorExplorer } from './device-mirror-explorer';
import { initPyboardDebug } from './pyboard-debug';
import { initTerminal } from './terminal';
import { initExtensionStatusView } from './extension-status-view';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export const activate = async (context: vscode.ExtensionContext) => {
  // Initialise output channel for logging
  initOutputChannel();
  logChannelOutput('Mekatrol Pyboard Dev activated...', false);

  // Create commands
  initCreateConfigCommand(context);
  initAutoDetectDevicesCommand(context);
  initConnectBoardCommand(context);
  initDisconnectBoardCommand(context);
  initSoftRebootBoardCommand(context);
  initSetAutoReconnectCommand(context);
  initToggleBoardConnectionCommand(context);
  initTerminal(context);
  await tryReconnectBoardOnStartup(context);

  // Init status bar
  await initStatusBar(context);
  initExtensionStatusView(context);

  // Init device mirror explorer
  await initDeviceMirrorExplorer(context);

  // Init Run/Debug integration
  initPyboardDebug(context);

};

// This method is called when your extension is deactivated
export async function deactivate() {
  const hasDirtyRemoteDocuments = vscode.workspace.textDocuments.some(
    (document) => document.uri.scheme === 'pyboarddev-remote' && document.isDirty
  );

  if (hasDirtyRemoteDocuments) {
    return;
  }

  await closeConnectedBoard(false, true, false, false);
}
