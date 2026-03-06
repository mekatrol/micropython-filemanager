/**
 * Module overview:
 * This file is part of the Pydevice extension runtime and contains
 * feature-specific logic isolated for maintainability and unit testing.
 */
import * as vscode from 'vscode';
import { configurationFileName, getConfigurationFullFileName, PydeviceConfigurationResult, resetDefaultConfiguration } from '../utils/configuration';
import { logChannelOutput } from '../output-channel';

export const initCreateConfigCommand = (context: vscode.ExtensionContext) => {
  const command = vscode.commands.registerCommand('mekatrol.pydevice.initconfig', async () => {
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
      case PydeviceConfigurationResult.AlreadyExists:
        {
          const msg = `Pydevice configuration file already exists: '${fileNameOrError}'.`;
          vscode.window.showWarningMessage(msg);
          logChannelOutput(msg, true);
        }
        break;

      case PydeviceConfigurationResult.Created:
        {
          const msg = `Pydevice configuration file reset: '${fileNameOrError}'.`;
          vscode.window.showInformationMessage(msg);
          logChannelOutput(msg, true);
        }
        break;

      case PydeviceConfigurationResult.NoWorkspace:
        {
          const msg = 'Open a workspace to reset the Pydevice configuration file.';
          vscode.window.showInformationMessage(msg);
          logChannelOutput(msg, true);
        }
        break;

      case PydeviceConfigurationResult.Error:
        {
          const msg = `Error resetting Pydevice configuration file: ${fileNameOrError}.`;
          vscode.window.showErrorMessage(msg);
          logChannelOutput(msg, true);
        }
        break;
    }
  });

  context.subscriptions.push(command);
};
