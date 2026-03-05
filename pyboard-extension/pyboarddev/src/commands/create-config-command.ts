import * as vscode from 'vscode';
import { configurationFileName, getConfigurationFullFileName, PyboardDevConfigurationResult, resetDefaultConfiguration } from '../utils/configuration';
import { logChannelOutput } from '../output-channel';

export const initCreateConfigCommand = (context: vscode.ExtensionContext) => {
  const command = vscode.commands.registerCommand('mekatrol.pyboarddev.initconfig', async () => {
    const configurationPath = getConfigurationFullFileName() ?? configurationFileName;
    const action = await vscode.window.showWarningMessage(
      `Reset ${configurationPath} to default values? This will overwrite any existing configuration.`,
      { modal: true },
      'Reset'
    );
    if (action !== 'Reset') {
      return;
    }

    const [result, fileNameOrError] = await resetDefaultConfiguration();

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
          const msg = `Pyboard Dev configuration file reset: '${fileNameOrError}'.`;
          vscode.window.showInformationMessage(msg);
          logChannelOutput(msg, true);
        }
        break;

      case PyboardDevConfigurationResult.NoWorkspace:
        {
          const msg = 'Open a workspace to reset the Pyboard Dev configuration file.';
          vscode.window.showInformationMessage(msg);
          logChannelOutput(msg, true);
        }
        break;

      case PyboardDevConfigurationResult.Error:
        {
          const msg = `Error resetting Pyboard Dev configuration file: ${fileNameOrError}.`;
          vscode.window.showErrorMessage(msg);
          logChannelOutput(msg, true);
        }
        break;
    }
  });

  context.subscriptions.push(command);
};
