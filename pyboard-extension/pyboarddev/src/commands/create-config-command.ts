import * as vscode from 'vscode';
import { createDefaultConfiguration, PyboardDevConfigurationResult } from '../utils/configuration';
import { logChannelOutput } from '../output-channel';

export const initCreateConfigCommand = (context: vscode.ExtensionContext) => {
  const command = vscode.commands.registerCommand('mekatrol.pyboarddev.initconfig', async () => {
    const [result, fileNameOrError] = await createDefaultConfiguration();

    switch (result) {
      case PyboardDevConfigurationResult.AlreadyExists:
        {
          const msg = `Pyboard Dev configuration file already exists: '${fileNameOrError}'.`;
          vscode.window.showWarningMessage(msg);
          logChannelOutput(msg, true);
        }
        break;

      case PyboardDevConfigurationResult.Created:
        {
          const msg = `Pyboard Dev configuration file created: '${fileNameOrError}'.`;
          vscode.window.showInformationMessage(msg);
          logChannelOutput(msg, true);
        }
        break;

      case PyboardDevConfigurationResult.NoWorkspace:
        {
          const msg = 'Open a workspace to add a Pyboard Dev configuration file.';
          vscode.window.showInformationMessage(msg);
          logChannelOutput(msg, true);
        }
        break;

      case PyboardDevConfigurationResult.Error:
        {
          const msg = `Error creating Pyboard Dev configuration file: ${fileNameOrError}.`;
          vscode.window.showErrorMessage(msg);
          logChannelOutput(msg, true);
        }
        break;
    }
  });

  context.subscriptions.push(command);
};
