/**
 * Module overview:
 * Registers the command that creates or resets the workspace
 * `.pydevice/config.json` file and reports results to the user.
 */
import * as vscode from 'vscode';
import { configurationFileName, getConfigurationFullFileName, PyDeviceConfigurationResult, resetDefaultConfiguration } from '../utils/configuration';
import { logChannelOutput } from '../output-channel';
import { showErrorMessage, showInformationMessage, showWarningMessage, t } from '../utils/i18n';

export const initCreateConfigCommand = (context: vscode.ExtensionContext) => {
  const command = vscode.commands.registerCommand('mekatrol.pydevice.initconfig', async () => {
    const configurationPath = getConfigurationFullFileName() ?? configurationFileName;
    const action = await showWarningMessage(
      `Reset ${configurationPath} to default values? This will overwrite any existing configuration.`,
      { modal: true },
      t('Reset')
    );
    if (action !== t('Reset')) {
      return;
    }

    const [result, fileNameOrError] = await resetDefaultConfiguration();

    switch (result) {
      case PyDeviceConfigurationResult.AlreadyExists:
        {
          const msg = `PyDevice configuration file already exists: '${fileNameOrError}'.`;
          showWarningMessage(msg);
          logChannelOutput(msg, true);
        }
        break;

      case PyDeviceConfigurationResult.Created:
        {
          const msg = `PyDevice configuration file reset: '${fileNameOrError}'.`;
          showInformationMessage(msg);
          logChannelOutput(msg, true);
        }
        break;

      case PyDeviceConfigurationResult.NoWorkspace:
        {
          const msg = 'Open a workspace to reset the PyDevice configuration file.';
          showInformationMessage(msg);
          logChannelOutput(msg, true);
        }
        break;

      case PyDeviceConfigurationResult.Error:
        {
          const msg = `Error resetting PyDevice configuration file: ${fileNameOrError}.`;
          showErrorMessage(msg);
          logChannelOutput(msg, true);
        }
        break;
    }
  });

  context.subscriptions.push(command);
};
