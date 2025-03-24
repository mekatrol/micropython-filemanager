// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { createDefaultConfiguration, PyboardDevConfigurationResult } from './utils/configuration';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  // The command has been defined in the package.json file
  // Now provide the implementation of the command with registerCommand
  // The commandId parameter must match the command field in package.json
  const disposable = vscode.commands.registerCommand('mekatrol.pyboarddev.initconfig', async () => {
    const [result, fileNameOrError] = await createDefaultConfiguration();

    switch (result) {
      case PyboardDevConfigurationResult.AlreadyExists:
        vscode.window.showWarningMessage(`Pyboard Dev configuration file already exists: '${fileNameOrError}'.`);
        break;

      case PyboardDevConfigurationResult.Created:
        vscode.window.showInformationMessage(`Pyboard Dev configuration file created: '${fileNameOrError}'.`);
        break;

      case PyboardDevConfigurationResult.NoWorkspace:
        vscode.window.showInformationMessage('Open a workspace to add a Pyboard Dev configuration file.');
        break;

      case PyboardDevConfigurationResult.Error:
        vscode.window.showErrorMessage(`Error creating Pyboard Dev configuration file: ${fileNameOrError}.`);
        break;
    }
  });

  context.subscriptions.push(disposable);
}

// This method is called when your extension is deactivated
export function deactivate() {}
